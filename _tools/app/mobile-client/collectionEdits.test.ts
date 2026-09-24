import {beforeEach,describe,expect,it,vi} from 'vitest';

const mocks=vi.hoisted(()=>({api:vi.fn()}));
vi.mock('./transport',async()=>{
  const actual=await vi.importActual<typeof import('./transport')>('./transport');
  return {...actual,api:mocks.api};
});

import {ApiError} from './transport';
import {flushCollectionEdits,PERSONAL_EDIT_PATH} from './collectionEditDelivery';
import {SAVE_FAILED,commitCollectionEdit,normalizeCollectionEdit,readCollectionEdit,readCollectionEdits,resolveCollectionEditConflict,visibleCollectionEdit} from './collectionEditOutbox';

const LIBRARY='e'.repeat(32);
const ready={revision:'r1',capabilities:{collectionPersonalEdit:true},libraryId:LIBRARY,personalEditCursor:0,appliedPersonalEditCursor:0};
const conflict=(current:unknown)=>new ApiError('서버가 요청을 처리하지 못했습니다.',409,{detail:{code:'collectionPersonalConflict',message:'m',current}});
type Body={operationId:string;field:string;value:unknown;expected:unknown;libraryId:string;collectionId:string;version:number};
/** Serve `/status` and hand each command to `command`. */
function install(command:(body:Body)=>unknown,status:unknown=ready){
  mocks.api.mockImplementation(async(path:string,_signal:unknown,body?:Body)=>{
    if(path==='/v1/collections/status')return status;
    if(path===PERSONAL_EDIT_PATH&&body){const reply=command(body);if(reply instanceof Error)throw reply;return reply;}
    throw new Error('unexpected '+path);
  });
}
const sent=()=>mocks.api.mock.calls.filter(([path])=>path===PERSONAL_EDIT_PATH).map(([, ,body])=>body as Body);
const receipt=(body:Body,changed=true)=>({version:1,operationId:body.operationId,collectionId:body.collectionId,field:body.field,value:body.value,sequence:changed?1:null,revision:'r2',changed});

beforeEach(()=>{localStorage.clear();mocks.api.mockReset();vi.restoreAllMocks();});

describe('collection edit outbox',()=>{
  it('persists one intent per field across a reload and replaces it with a new id',()=>{
    const first=commitCollectionEdit('a','myScore',4.5,3)!;
    commitCollectionEdit('a','memo','메모',null);
    // A reload reads the same durable rows.
    expect(JSON.parse(localStorage.getItem('lakomics.collections.edits.outbox.v1')!)['a:myScore'].operationId).toBe(first.operationId);
    expect(Object.keys(readCollectionEdits()).sort()).toEqual(['a:memo','a:myScore']);
    const second=commitCollectionEdit('a','myScore',2,4.5)!;
    expect(second.operationId).not.toBe(first.operationId);
    // Still composed against the server value, remembering the replaced value as its own.
    expect([second.expected,second.own]).toEqual([3,[4.5]]);
    expect(Object.keys(readCollectionEdits())).toHaveLength(2);
    // Repeating the queued value keeps the operation id.
    expect(commitCollectionEdit('a','myScore',2,3)!.operationId).toBe(second.operationId);
    expect(visibleCollectionEdit('a','myScore',3)).toEqual({value:2,pending:true,conflict:false});
  });
  it('does not queue the value the server already has',()=>{
    expect(commitCollectionEdit('a','showcase',true,true)).toBeNull();
    expect(commitCollectionEdit('a','memo','  ',null)).toBeNull();
    expect(readCollectionEdits()).toEqual({});
  });
  it('validates like the PC',()=>{
    expect(normalizeCollectionEdit('myScore',0)).toBe(0);
    expect(normalizeCollectionEdit('myScore',null)).toBeNull();
    for(const score of [5.5,-0.5,2.25,Number.NaN])expect(()=>normalizeCollectionEdit('myScore',score)).toThrow();
    expect(()=>normalizeCollectionEdit('showcase',null)).toThrow();
    expect(normalizeCollectionEdit('memo','  메모  ')).toBe('메모');
    expect(normalizeCollectionEdit('memo','   ')).toBeNull();
    expect(normalizeCollectionEdit('memo','가'.repeat(2000))).toHaveLength(2000);
    // Counted in characters: 2000 emoji are 4000 UTF-16 units but still allowed.
    expect(()=>normalizeCollectionEdit('memo','😀'.repeat(2000))).not.toThrow();
    expect(()=>normalizeCollectionEdit('memo','가'.repeat(2001))).toThrow('2,000자');
    expect(()=>commitCollectionEdit('a','myScore',7,3)).toThrow();
    expect(readCollectionEdits()).toEqual({});
  });
  it('reports an edit the device could not store instead of pretending it is queued',()=>{
    const first=commitCollectionEdit('a','myScore',4,3)!;
    vi.spyOn(Storage.prototype,'setItem').mockImplementation(()=>{throw new DOMException('full','QuotaExceededError');});
    expect(()=>commitCollectionEdit('a','myScore',5,3)).toThrow(SAVE_FAILED);
    expect(()=>commitCollectionEdit('b','memo','메모',null)).toThrow(SAVE_FAILED);
    // The stored queue is unchanged.
    expect(readCollectionEdits()).toEqual({'a:myScore':first});
  });
});

describe('collection edit delivery',()=>{
  it('withholds every send until the server advertises the capability',async()=>{
    commitCollectionEdit('a','myScore',4,3);
    install(()=>{throw new Error('must not send');},{revision:'r1',capabilities:{collectionPersonalEdit:false}});
    const report=await flushCollectionEdits();
    expect(report.unsupported).toBe(true);
    expect(sent()).toHaveLength(0);
    expect(readCollectionEdit('a','myScore')).not.toBeNull();
    // An older server without the field is the same answer.
    install(()=>{throw new Error('must not send');},{revision:'r1'});
    expect((await flushCollectionEdits()).unsupported).toBe(true);
  });
  it('sends nothing, not even status, when the queue is empty',async()=>{
    install(()=>null);
    expect((await flushCollectionEdits()).outcomes).toEqual([]);
    expect(mocks.api).not.toHaveBeenCalled();
  });
  it('removes the intent on receipt and treats changed:false as confirmation',async()=>{
    commitCollectionEdit('a','myScore',4,3);commitCollectionEdit('b','showcase',true,false);
    install(body=>receipt(body,body.collectionId==='a'));
    const report=await flushCollectionEdits();
    expect(report.outcomes.map(o=>o.outcome)).toEqual(['confirmed','already-current']);
    expect(sent()[0]).toMatchObject({version:1,libraryId:LIBRARY,collectionId:'a',field:'myScore',value:4,expected:3});
    expect(readCollectionEdits()).toEqual({});
  });
  it('retries a lost response with the same operation id',async()=>{
    const intent=commitCollectionEdit('a','memo','메모',null)!;
    install(()=>new Error('연결 시간이 초과되었습니다.'));
    await expect(flushCollectionEdits()).rejects.toThrow('연결 시간');
    expect(readCollectionEdit('a','memo')?.operationId).toBe(intent.operationId);
    install(body=>receipt(body));
    await flushCollectionEdits();
    expect(sent().map(body=>body.operationId)).toEqual([intent.operationId,intent.operationId]);
    expect(readCollectionEdits()).toEqual({});
  });
  it('ignores a late receipt for an intent a newer action replaced',async()=>{
    commitCollectionEdit('a','myScore',4,3);
    let replacement='';
    install(body=>{if(!replacement)replacement=commitCollectionEdit('a','myScore',5,3)!.operationId;return receipt(body);});
    const report=await flushCollectionEdits();
    expect(report.outcomes[0].outcome).toBe('superseded');
    expect(readCollectionEdit('a','myScore')?.operationId).toBe(replacement);
  });
  it('rebases a rating once onto the current value under a new id',async()=>{
    const intent=commitCollectionEdit('a','myScore',4,3)!;
    install(body=>body.expected===3?conflict(2.5):receipt(body));
    expect((await flushCollectionEdits()).outcomes[0].outcome).toBe('confirmed');
    // A changed payload never reuses an operation id.
    const [first,second]=sent();
    expect([first.operationId,first.expected,second.expected]).toEqual([intent.operationId,3,2.5]);
    expect(second.operationId).not.toBe(intent.operationId);
    // A second consecutive conflict leaves the intent queued for a later pass.
    commitCollectionEdit('b','myScore',4,3);
    mocks.api.mockClear();
    let calls=0;install(()=>conflict(++calls===1?2:1));
    expect((await flushCollectionEdits()).outcomes[0].outcome).toBe('deferred');
    expect(readCollectionEdit('b','myScore')?.expected).toBe(1);
    expect(sent()).toHaveLength(2);
  });
  it('completes when the conflict already holds the wanted value',async()=>{
    commitCollectionEdit('a','showcase',true,false);
    install(()=>conflict(true));
    expect((await flushCollectionEdits()).outcomes[0].outcome).toBe('already-current');
    expect(readCollectionEdits()).toEqual({});
  });
  it('parks a memo conflict for the user, then overwrites or discards',async()=>{
    const intent=commitCollectionEdit('a','memo','내 메모','예전')!;
    install(body=>body.expected==='예전'?conflict('PC 메모'):receipt(body));
    expect((await flushCollectionEdits()).outcomes[0].outcome).toBe('conflict');
    expect(visibleCollectionEdit('a','memo','PC 메모')).toEqual({value:'내 메모',pending:true,conflict:true});
    expect(readCollectionEdit('a','memo')?.conflict).toEqual({current:'PC 메모'});
    // A parked memo is not resent until the user chooses.
    expect((await flushCollectionEdits()).outcomes[0].outcome).toBe('conflict');
    expect(sent()).toHaveLength(1);
    resolveCollectionEditConflict('a','memo','overwrite');
    expect((await flushCollectionEdits()).outcomes[0].outcome).toBe('confirmed');
    expect(sent().at(-1)).toMatchObject({expected:'PC 메모',value:'내 메모'});
    expect(sent().at(-1)!.operationId).not.toBe(intent.operationId);
    commitCollectionEdit('b','memo','초안',null);
    install(()=>conflict('PC'));
    await flushCollectionEdits();
    expect(resolveCollectionEditConflict('b','memo','discard')).toBeNull();
    expect(readCollectionEdits()).toEqual({});
  });
  it('rebases a memo silently when the server holds this device\'s own earlier value',async()=>{
    commitCollectionEdit('a','memo','첫 초안',null);
    commitCollectionEdit('a','memo','둘째 초안',null);
    // The first draft was accepted but its response was lost before the replacement.
    install(body=>body.expected===null?conflict('첫 초안'):receipt(body));
    expect((await flushCollectionEdits()).outcomes[0].outcome).toBe('confirmed');
    expect(sent().at(-1)).toMatchObject({value:'둘째 초안',expected:'첫 초안'});
  });
  it('drops an edit for a deleted Collection with a message but keeps it on other failures',async()=>{
    commitCollectionEdit('gone','myScore',4,3);
    install(()=>new ApiError('없음',404,{detail:{code:'collectionNotFound',message:'m'}}));
    const [dropped]=(await flushCollectionEdits()).outcomes;
    expect(dropped.outcome).toBe('rejected');
    expect(dropped.message).toContain('PC에서 삭제');
    expect(readCollectionEdits()).toEqual({});
    commitCollectionEdit('a','myScore',4,3);
    const refused=new ApiError('다른 라이브러리',409,{detail:{code:'libraryMismatch',message:'m'}});
    install(()=>refused);
    const report=await flushCollectionEdits();
    expect(report.outcomes).toEqual([{key:'a:myScore',outcome:'failed'}]);
    expect(report.error).toBe(refused);
    expect(readCollectionEdit('a','myScore')).not.toBeNull();
  });
  it('keeps sending the other intents after one is refused',async()=>{
    commitCollectionEdit('a','myScore',4,3);
    commitCollectionEdit('b','showcase',true,false);
    install(body=>body.collectionId==='a'?new ApiError('x',409,{detail:{code:'libraryMismatch',message:'m'}}):receipt(body));
    const report=await flushCollectionEdits();
    expect(report.outcomes.map(o=>o.outcome)).toEqual(['failed','confirmed']);
    expect(Object.keys(readCollectionEdits())).toEqual(['a:myScore']);
    // A transport failure still ends the pass.
    commitCollectionEdit('b','showcase',false,true);
    install(()=>new Error('연결 시간이 초과되었습니다.'));
    await expect(flushCollectionEdits()).rejects.toThrow('연결 시간');
    // 'a' (older) failed in transport, so the new 'b' edit was not sent in that pass.
    expect(sent().filter(body=>body.collectionId==='b').map(body=>body.value)).toEqual([true]);
  });
  it('retries once under a new id when the server reports operationConflict',async()=>{
    const intent=commitCollectionEdit('a','myScore',4,3)!;
    const reused=new ApiError('x',409,{detail:{code:'operationConflict',message:'m'}});
    install(body=>body.operationId===intent.operationId?reused:receipt(body));
    expect((await flushCollectionEdits()).outcomes[0].outcome).toBe('confirmed');
    const [first,second]=sent();
    expect(first.operationId).toBe(intent.operationId);
    expect(second).toMatchObject({value:4,expected:3});
    expect(second.operationId).not.toBe(intent.operationId);
    expect(readCollectionEdits()).toEqual({});
    // Only once per pass: a second refusal waits under the newest id.
    commitCollectionEdit('b','myScore',4,3);
    mocks.api.mockClear();
    install(()=>reused);
    expect((await flushCollectionEdits()).outcomes[0].outcome).toBe('deferred');
    expect(sent()).toHaveLength(2);
    expect(readCollectionEdit('b','myScore')?.operationId).not.toBe(sent()[1].operationId);
  });
});
