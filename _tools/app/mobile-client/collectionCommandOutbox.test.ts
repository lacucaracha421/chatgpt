import {beforeEach, describe, expect, it, vi} from 'vitest';
import {setOutboxConnection} from './outboxConnection';
const mocks = vi.hoisted(() => ({api: vi.fn()}));
vi.mock('./transport', async () => ({...await vi.importActual<typeof import('./transport')>('./transport'), api: mocks.api}));
import {ApiError} from './transport';
import {AUTHORITY_STATUS_PATH, COMMAND_PATH, authorityIdentity, confirmedWork, createdWork, discardLifecycle, enqueueCommand, enqueueCommands, flushCommands, lifecycleInFlight, retryCommandNow,
  optimisticWork, readCommands, reconcileCommands, replaceCommand, type AuthorityIdentity, type WorkCommand} from './collectionCommandOutbox';
import {avCredits, AV_INPUT_ERROR} from './avEditModel';
import type {CollectionDetail} from './collectionModel';

const identity: AuthorityIdentity = {libraryId: 'e'.repeat(32), epoch: 7, contractVersion: 1};
const connection = 'https://a.example';
const create: WorkCommand = {commandType: 'createWork', workId: 'new-work', type: 'game', name: '새 게임', legacyKind: null, binding: null, fields: {developer: '개발사'}};
const update = (name = '새 이름'): WorkCommand => ({commandType: 'updateWork', workId: create.workId, changes: {name}, expected: {name: create.name}, expectedRevision: null});
const refused = (code: string) => new ApiError('거절', 409, {detail: {code, current: {work: {name: '다른 이름', fields: {description: '다른 메모'}}}}});
function server(command: (body: WorkCommand) => unknown = () => ({}), status: unknown = {...identity, active: true}) {
  mocks.api.mockImplementation(async (path: string, _signal: unknown, body: WorkCommand) => {
    if (path === AUTHORITY_STATUS_PATH) return status;
    const reply = command(body); if (reply instanceof Error) throw reply; return {...body, ...reply as object};
  });
}
const sent = () => mocks.api.mock.calls.filter(([path]) => path === COMMAND_PATH).map(([, , body]) => body);
beforeEach(() => { localStorage.clear(); setOutboxConnection(connection); mocks.api.mockReset(); vi.restoreAllMocks(); });
describe('durable Collection commands', () => {
  it('keeps connection review intent until replica readback, supports FIFO undo and ignores a changed volume set', async () => {
    const item: CollectionDetail = {id:'m',name:'Manga',type:'manga',showcase:false,volumes:[],artworks:[],kakaoReview:{collectionId:'m',query:'만화',querySource:'name',bound:true,volumes:[1,3],highestOwnedVolume:3,ownedCount:0,partialDismissed:false,groupFingerprints:[],minVolume:null,maxVolume:null,hideConnectionPrompt:false}};
    enqueueCommand(identity,{commandType:'setKakaoPartialDismissed',workId:'m',dismissed:true,expectedVolumes:[1,3]});
    server(); await flushCommands();
    const accepted=readCommands();
    expect(confirmedWork(item,accepted).kakaoReview!.partialDismissed).toBe(true);
    reconcileCommands(identity,item); expect(readCommands()).toHaveLength(1);
    const changed={...item,kakaoReview:{...item.kakaoReview!,volumes:[1,2,3]}};
    expect(confirmedWork(changed,accepted).kakaoReview!.partialDismissed).toBe(false);
    enqueueCommand(identity,{commandType:'setKakaoPartialDismissed',workId:'m',dismissed:false,expectedVolumes:[1,3]});
    server(); await flushCommands();
    expect(optimisticWork(item,readCommands()).kakaoReview!.partialDismissed).toBe(false);
    reconcileCommands(identity,item); expect(readCommands()).toEqual([]);
  });
  const av: CollectionDetail = {id:'av',name:'AV',type:'av',showcase:false,volumes:[],artworks:[],av:{productCode:'OLD',genres:['old'],people:[{id:'p1',name:'인물',role:'performer',order:0,creditName:null}]}};
  const details: WorkCommand = {commandType:'setAvDetails',workId:av.id,changes:{productCode:'NEW',genres:['new']},expected:{productCode:'OLD',genres:['old']}};
  const credits: WorkCommand = {commandType:'setAvCredits',workId:av.id,credits:[{personId:'p1',role:'director',order:0,creditName:'표기'}],people:[],expectedRevision:4};
  it.each([details,credits])('uses a single checked receipt for $commandType and preserves retry identity on a mismatched receipt', async command => {
    const row=enqueueCommand(identity,command);
    server(()=>({commandType:'updateWork'})); await flushCommands();
    expect(readCommands()[0]).toMatchObject({state:'pending',attempts:1});
    retryCommandNow(row.command.operationId); server(); await flushCommands();
    expect(readCommands()[0]).toMatchObject({state:'accepted',receipts:[{operationId:row.command.operationId,commandType:command.commandType}]});
    expect(readCommands()[0].receipts).toHaveLength(1);
  });
  it('reconciles AV arrays and credits without dropping stale overlays, retains confirmed state across surfaces, and lets later remote edits win', async () => {
    const people=[{...av.av!.people[0],role:'director' as const,creditName:'표기'}];
    enqueueCommands(identity,[credits,details],{people,expectedCredits:avCredits(av.av!.people)});
    server(); await flushCommands();
    const accepted=readCommands();
    const shown=optimisticWork(av,accepted);
    expect(shown.av).toMatchObject({productCode:'NEW',genres:['new'],people:[{id:'p1',role:'director',name:'인물',creditName:'표기'}]});
    reconcileCommands(identity,av,'detail'); expect(readCommands()).toHaveLength(2);
    reconcileCommands(identity,shown,'list'); expect(readCommands()).toEqual([]);
    expect(confirmedWork(av,accepted)).toEqual(shown);
    const remote={...shown,av:{...shown.av!,productCode:'REMOTE',genres:['remote'],people:[]}};
    expect(confirmedWork(remote,accepted)).toEqual(remote);
  });
  it('validates the complete AV batch before storing anything', () => {
    expect(()=>enqueueCommands(identity,[details,{...credits,expectedRevision:0}])).toThrow(AV_INPUT_ERROR);
    expect(readCommands()).toEqual([]);
    expect(()=>enqueueCommand(identity,{...details,expected:{maker:null}})).toThrow(AV_INPUT_ERROR);
  });
  it('rejects an oversized AV envelope without truncating names or storing part of the batch', () => {
    const people=Array.from({length:64},(_,index)=>({personId:`p${index}`,displayName:'あ'.repeat(500),nameJa:null}));
    const command: WorkCommand={commandType:'setAvCredits',workId:av.id,expectedRevision:4,people,
      credits:people.map((person,order)=>({personId:person.personId,order,role:'performer',creditName:'あ'.repeat(500)}))};
    expect(()=>enqueueCommands(identity,[details,command])).toThrow(AV_INPUT_ERROR);
    expect(readCommands()).toEqual([]);
  });
  it('keeps a delete visible as undelivered: why it waits, then sent again on 다시 시도, or dropped', async () => {
    const remove: WorkCommand = {commandType: 'deleteWork', workId: 'gone', expectedRevision: 3};
    const row = enqueueCommand(identity, remove, '지울 작품');
    expect(lifecycleInFlight(readCommands()[0])).toBe(true);
    server(() => new Error('연결 실패')); await flushCommands();
    expect(readCommands()[0]).toMatchObject({state: 'pending', attempts: 1, lastError: '연결 실패', label: '지울 작품'});
    expect(lifecycleInFlight(readCommands()[0])).toBe(false);
    server(); await flushCommands(); expect(sent()).toHaveLength(1);  // still backing off
    retryCommandNow(row.command.operationId); await flushCommands();
    expect(sent().at(-1)).toEqual(row.command);
    expect(readCommands()).toEqual([]);  // a confirmed delete leaves the queue
    // A delete waiting behind an earlier change of its work says so; 버리기 drops it.
    enqueueCommand(identity, {...update(), workId: 'held'});
    const blocked = enqueueCommand(identity, {...remove, workId: 'held'});
    server(body => body.commandType === 'updateWork' ? new ApiError('충돌', 409, {detail: {code: 'revisionConflict'}}) : ({})); await flushCommands();
    expect(readCommands()[1]).toMatchObject({state: 'pending', attempts: 0, lastError: '이 작품의 앞선 변경을 먼저 보내야 합니다.'});
    discardLifecycle(blocked.command.operationId);
    expect(readCommands().map(value => value.command.commandType)).toEqual(['updateWork']);
  });
  it('persists immutable envelopes, scopes connection/library/epoch and gates inactive status', async () => {
    const row = enqueueCommand(identity, create);
    expect(readCommands()[0]).toEqual(JSON.parse(JSON.stringify(row)));
    setOutboxConnection('https://b.example'); expect(readCommands()).toEqual([]);
    setOutboxConnection(connection); expect(readCommands()[0].command.operationId).toBe(row.command.operationId);
    for (const status of [{active: false}, {...identity, active: true, epoch: 8}, {...identity, active: true, libraryId: 'f'.repeat(32)}]) {
      server(undefined, status); await flushCommands(); expect(sent()).toHaveLength(0);
    }
    server(); await flushCommands(); expect(sent()[0]).toEqual(row.command);
    expect(mocks.api.mock.calls.find(([path]) => path === COMMAND_PATH)?.slice(3)).toEqual(['PUT', false, connection]);
  });
  it('orders create then edits and prevents a timeout from sending dependent edits', async () => {
    vi.spyOn(Date, 'now').mockReturnValue(1000);
    const first = enqueueCommand(identity, create); enqueueCommand(identity, update());
    server(() => new Error('offline')); await flushCommands();
    expect(sent()).toEqual([first.command]); expect(readCommands()[0]).toMatchObject({state: 'pending', attempts: 1, nextAttemptAt: 6000});
    server(); await flushCommands(); expect(sent()).toHaveLength(1);
    vi.spyOn(Date, 'now').mockReturnValue(6000); await flushCommands();
    expect(sent().map(command => command.commandType)).toEqual(['createWork', 'createWork', 'updateWork']);
    expect(sent()[1].operationId).toBe(first.command.operationId);
    expect(readCommands().map(row => row.state)).toEqual(['accepted', 'accepted']);
  });
  it('increases backoff and preserves retry payload after a lost response', async () => {
    let now = 1000; vi.spyOn(Date, 'now').mockImplementation(() => now);
    const row = enqueueCommand(identity, update()); server(() => new Error('timeout'));
    await flushCommands(); now = 6000; await flushCommands();
    expect(readCommands()[0]).toMatchObject({attempts: 2, nextAttemptAt: 16000});
    expect(sent()).toEqual([row.command, row.command]);
  });
  it('backs off status transport failures without sending commands or changing their identity', async () => {
    vi.spyOn(Date, 'now').mockReturnValue(1000);
    const row = enqueueCommand(identity, create);
    mocks.api.mockRejectedValue(new Error('offline'));
    await expect(flushCommands()).rejects.toThrow('offline');
    expect(readCommands()[0]).toMatchObject({attempts: 1, nextAttemptAt: 6000, command: row.command});
    expect(sent()).toHaveLength(0);
    await flushCommands(); expect(mocks.api).toHaveBeenCalledTimes(1);
  });
  it('parks conflicts, blocks dependents, continues other works and replaces only with a new id', async () => {
    const row = enqueueCommand(identity, create); enqueueCommand(identity, update());
    enqueueCommand(identity, {...update(), workId: 'other'});
    server(body => body.workId === create.workId ? refused('nameConflict') : {}); await flushCommands();
    expect(readCommands()[0]).toMatchObject({state: 'conflict', conflict: {code: 'nameConflict'}});
    expect(sent().map(command => command.workId)).toEqual([create.workId, 'other']);
    const replacement = replaceCommand(row.command.operationId, {...create, name: '중복 아닌 이름'});
    expect(replacement?.command.operationId).not.toBe(row.command.operationId);
    server(); await flushCommands(); expect(readCommands().every(row => row.state === 'accepted')).toBe(true);
  });
  it('drops all dependent commands on workDeleted, retaining other identities', async () => {
    enqueueCommand(identity, create); enqueueCommand(identity, update());
    enqueueCommand({...identity, epoch: 6}, update()); server(() => refused('workDeleted')); await flushCommands();
    expect(readCommands()).toHaveLength(1); expect(readCommands()[0].command.epoch).toBe(6);
  });
  it('keeps accepted optimistic values until read-back and retires superseded values together', async () => {
    enqueueCommand(identity, create); enqueueCommand(identity, update('first')); enqueueCommand(identity, update('last'));
    server(); await flushCommands();
    const item = createdWork(readCommands()[0])!;
    expect(optimisticWork(item, readCommands()).name).toBe('last');
    reconcileCommands(identity, item); expect(readCommands()).toHaveLength(2);
    expect(optimisticWork(item, readCommands()).name).toBe('last');
    reconcileCommands(identity, {...item, name: 'last'}); expect(readCommands()).toEqual([]);
  });
  it('refuses unsaved optimistic edits when local storage fails', () => {
    vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => { throw new Error('full'); });
    expect(() => enqueueCommand(identity, create)).toThrow('기기에 저장하지 못했습니다.');
    expect(readCommands()).toEqual([]);
  });
  it('does not send across a connection change while status is in flight', async () => {
    enqueueCommand(identity, create);
    server(() => ({})); mocks.api.mockImplementationOnce(async () => { setOutboxConnection('https://b.example'); return {...identity, active: true}; });
    await flushCommands(); expect(sent()).toHaveLength(0);
  });
  it('retains an accepted create until the shelf, rather than only the detail, reads it', async () => {
    const row = enqueueCommand(identity, create); server(); await flushCommands();
    const item = createdWork(row)!;
    reconcileCommands(identity, item, 'detail'); expect(readCommands()).toHaveLength(1);
    reconcileCommands(identity, item, 'list'); expect(readCommands()).toHaveLength(0);
  });
  it.each([401, 403, 408, 429, 503])('retries temporary HTTP %s failures with the original id', async status => {
    const row = enqueueCommand(identity, update()); server(() => new ApiError('일시 실패', status, null));
    await flushCommands(); expect(readCommands()[0]).toMatchObject({state: 'pending', attempts: 1});
    expect(sent()[0].operationId).toBe(row.command.operationId);
  });
  it('keeps a command when the success response does not confirm its immutable envelope', async () => {
    enqueueCommand(identity, update()); server(() => ({operationId: 'wrong-operation'}));
    await flushCommands(); expect(readCommands()[0]).toMatchObject({state: 'pending', attempts: 1});
  });
  it('validates active identity rather than assuming epoch one', () => {
    expect(authorityIdentity({...identity, active: true})).toEqual(identity);
    expect(authorityIdentity({...identity, active: true, contractVersion: 2})).toBeNull();
    expect(authorityIdentity({...identity, active: true, epoch: 0})).toBeNull();
  });
});
