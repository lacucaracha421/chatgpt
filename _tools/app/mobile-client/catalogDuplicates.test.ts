import {beforeEach,describe,expect,it,vi} from 'vitest';
import {setOutboxConnection} from './outboxConnection';
const CONNECTION='https://a.example';

const mocks=vi.hoisted(()=>({api:vi.fn()}));
vi.mock('./transport',async()=>{
  const actual=await vi.importActual<typeof import('./transport')>('./transport');
  return {...actual,api:mocks.api};
});

import {ApiError} from './transport';
import {DUPLICATE_DECISIONS_PATH,DUPLICATE_SEND_DELAY_MS,DUPLICATE_SETTLED_EVENT,commitDuplicateDecision,duplicatesPath,flushDuplicateDecisions,nextDuplicateDue,readDuplicateIntents,undoDuplicateDecision} from './catalogDuplicates';

type Body={version:number;operationId:string;candidateId:string;decision:string;expectedRevision:number};
const C1='a'.repeat(32),C2='b'.repeat(32);
const undecided=(candidateId=C1)=>({candidateId,decision:null,decisionRevision:0});
const merged=(candidateId=C1,revision=3)=>({candidateId,decision:{decision:'keepBoth',hiddenWorkId:null},decisionRevision:revision});
const refused=(code:string,status=409,message='다른 기기에서 먼저 검토했습니다. 새로고침해 주세요.')=>new ApiError('refused',status,{detail:{code,message}});
function install(reply:(body:Body)=>unknown){
  mocks.api.mockImplementation(async(path:string,_signal:unknown,body?:Body)=>{
    if(path===DUPLICATE_DECISIONS_PATH&&body){const value=reply(body);if(value instanceof Error)throw value;return value;}
    throw new Error('unexpected '+path);
  });
}
const sent=()=>mocks.api.mock.calls.filter(([path])=>path===DUPLICATE_DECISIONS_PATH).map(([, ,body])=>body as Body);
const later=()=>Date.now()+DUPLICATE_SEND_DELAY_MS+1;
let ids=0;
const nextId=()=>`00000000-0000-4000-8000-${String(++ids).padStart(12,'0')}`;

beforeEach(()=>{setOutboxConnection(CONNECTION);localStorage.clear();mocks.api.mockReset();});

describe('duplicate review outbox',()=>{
  it('builds review list paths with state, limit and cursor',()=>{
    expect(duplicatesPath('undecided')).toBe('/v1/mobile-catalog/duplicates?state=undecided&limit=20');
    expect(duplicatesPath('decided','Mg',5)).toBe('/v1/mobile-catalog/duplicates?state=decided&limit=5&cursor=Mg');
  });
  it('keeps one delayed intent per candidate; a change keeps the server basis, returning to it removes the intent',()=>{
    const first=commitDuplicateDecision(undecided(),'keepBoth',nextId,1000)!;
    expect(first).toMatchObject({candidateId:C1,decision:'keepBoth',base:null,expectedRevision:0,notBefore:1000+DUPLICATE_SEND_DELAY_MS});
    expect(nextDuplicateDue()).toBe(1000+DUPLICATE_SEND_DELAY_MS);
    const changed=commitDuplicateDecision(undecided(),'notDuplicate',nextId,2000)!;
    expect(changed.operationId).not.toBe(first.operationId);
    expect(readDuplicateIntents()[C1]).toMatchObject({decision:'notDuplicate',base:null,expectedRevision:0});
    // A merged pair changed to "다른 작품" and back again leaves nothing to send.
    expect(commitDuplicateDecision(merged(C2,3),'notDuplicate',nextId)).toMatchObject({base:'keepBoth',expectedRevision:3});
    expect(commitDuplicateDecision(merged(C2,3),'keepBoth',nextId)).toBeNull();
    expect(Object.keys(readDuplicateIntents())).toEqual([C1]);
    expect(commitDuplicateDecision(merged(C2,3),'keepBoth',nextId)).toBeNull();
  });
  it('undoes an unsent decision',()=>{
    const intent=commitDuplicateDecision(undecided(),'keepBoth',nextId)!;
    expect(undoDuplicateDecision(intent)).toBe(true);
    expect(readDuplicateIntents()).toEqual({});
    expect(undoDuplicateDecision(intent)).toBe(false);
  });
});

describe('duplicate review delivery',()=>{
  it('waits out the undo window, then posts the decision with expectedRevision and operationId',async()=>{
    install(body=>({version:1,operationId:body.operationId,revision:body.expectedRevision+1}));
    const keep=commitDuplicateDecision(undecided(C1),'keepBoth',nextId)!;
    const split=commitDuplicateDecision(merged(C2,3),'notDuplicate',nextId)!;
    expect(await flushDuplicateDecisions()).toEqual([]);
    expect(sent()).toEqual([]);
    const settled:unknown[]=[];
    const listen=(event:Event)=>settled.push((event as CustomEvent).detail);
    window.addEventListener(DUPLICATE_SETTLED_EVENT,listen);
    const outcomes=await flushDuplicateDecisions(later);
    window.removeEventListener(DUPLICATE_SETTLED_EVENT,listen);
    expect(sent()).toEqual([
      {version:1,operationId:keep.operationId,candidateId:C1,decision:'keepBoth',expectedRevision:0},
      {version:1,operationId:split.operationId,candidateId:C2,decision:'notDuplicate',expectedRevision:3},
    ]);
    expect(outcomes.map(outcome=>outcome.outcome)).toEqual(['confirmed','confirmed']);
    expect(settled).toHaveLength(2);
    expect(readDuplicateIntents()).toEqual({});
  });
  it('drops a decision another device made first (409) and reports the server message',async()=>{
    install(()=>refused('duplicateDecisionConflict'));
    commitDuplicateDecision(undecided(),'notDuplicate',nextId);
    expect(await flushDuplicateDecisions(later)).toEqual([{candidateId:C1,outcome:'rejected',message:'다른 기기에서 먼저 검토했습니다. 새로고침해 주세요.'}]);
    expect(readDuplicateIntents()).toEqual({});
  });
  it('keeps the decision and its operation id while offline, and resends the same id later',async()=>{
    install(()=>new ApiError('offline',null,null));
    const intent=commitDuplicateDecision(undecided(),'keepBoth',nextId)!;
    await expect(flushDuplicateDecisions(later)).rejects.toThrow('offline');
    expect(readDuplicateIntents()[C1].operationId).toBe(intent.operationId);
    install(body=>({operationId:body.operationId}));
    await flushDuplicateDecisions(later);
    expect(sent().map(body=>body.operationId)).toEqual([intent.operationId,intent.operationId]);
    expect(readDuplicateIntents()).toEqual({});
  });
  it('retries once under a new id after an operation conflict',async()=>{
    const reused='00000000-0000-4000-8000-000000000999';
    install(body=>body.operationId===reused?refused('operationConflict'):{operationId:body.operationId});
    commitDuplicateDecision(undecided(),'keepBoth',()=>reused);
    const outcomes=await flushDuplicateDecisions(later);
    expect(sent()).toHaveLength(2);
    expect(sent()[1].operationId).not.toBe(sent()[0].operationId);
    expect(outcomes).toEqual([{candidateId:C1,outcome:'confirmed'}]);
  });
});

describe('duplicate review connection identity',()=>{
  it('never sends a decision queued on server A to server B, and sends it on returning to A',async()=>{
    const intent=commitDuplicateDecision(undecided(),'keepBoth',nextId)!;
    setOutboxConnection('https://b.example');
    install(()=>{throw new Error('must not send');});
    expect(readDuplicateIntents()).toEqual({});
    expect(await flushDuplicateDecisions(later)).toEqual([]);
    expect(mocks.api).not.toHaveBeenCalled();
    setOutboxConnection(CONNECTION);
    install(body=>({operationId:body.operationId}));
    expect(await flushDuplicateDecisions(later)).toEqual([{candidateId:C1,outcome:'confirmed'}]);
    expect(sent()).toEqual([expect.objectContaining({operationId:intent.operationId,candidateId:C1})]);
    expect(mocks.api.mock.calls.every(call=>call[5]===CONNECTION)).toBe(true);
  });
  it('moves the pre-upgrade queue to the first known connection',async()=>{
    setOutboxConnection(null);
    const legacy={candidateId:C1,decision:'keepBoth',base:null,expectedRevision:0,operationId:nextId(),createdAt:1,notBefore:1};
    localStorage.setItem('lakomics.catalog.duplicates.outbox.v1',JSON.stringify({[C1]:legacy}));
    setOutboxConnection(CONNECTION);
    expect(readDuplicateIntents()).toEqual({[C1]:legacy});
    setOutboxConnection('https://b.example');
    expect(readDuplicateIntents()).toEqual({});
  });
});
