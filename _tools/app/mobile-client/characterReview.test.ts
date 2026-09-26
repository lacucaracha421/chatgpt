import {beforeEach,describe,expect,it,vi} from 'vitest';
import {outboxKey,setOutboxConnection} from './outboxConnection';
const CONNECTION='https://a.example';

const mocks=vi.hoisted(()=>({api:vi.fn()}));
vi.mock('./transport',async()=>{
  const actual=await vi.importActual<typeof import('./transport')>('./transport');
  return {...actual,api:mocks.api};
});

import {ApiError} from './transport';
import {REVIEW_DECISIONS_PATH,flushCharacterReview,isReviewInFlight} from './characterReviewDelivery';
import {REVIEW_OUTBOX_FULL,REVIEW_OUTBOX_LIMIT,commitReviewDecision,queuedReviewPairs,readReviewIntents,undoReviewDecision} from './characterReviewOutbox';

const LIBRARY='e'.repeat(32);
const ready={version:1,ready:true,libraryId:LIBRARY,counts:{total:0},items:[],targets:{},nextCursor:null,hasMore:false};
type Body={operationId:string;targetId:string;assetId:string;decision:string;origin:string;basis:string|null;libraryId:string;version:number};
const refused=(code:string,status=409)=>new ApiError('refused',status,{detail:{code,message:'m'}});
function install(command:(body:Body)=>unknown,feed:unknown=ready){
  mocks.api.mockImplementation(async(path:string,_signal:unknown,body?:Body)=>{
    if(path.startsWith('/v1/library/characters/review?'))return feed;
    if(path===REVIEW_DECISIONS_PATH&&body){const reply=command(body);if(reply instanceof Error)throw reply;return reply;}
    throw new Error('unexpected '+path);
  });
}
const sent=()=>mocks.api.mock.calls.filter(([path])=>path===REVIEW_DECISIONS_PATH).map(([, ,body])=>body as Body);
const decide=(assetId:string,decision:'accepted'|'rejected'='accepted',targetId='c')=>
  commitReviewDecision({libraryId:LIBRARY,targetId,assetId,decision,origin:'feed',basis:'b1'});

beforeEach(()=>{setOutboxConnection(CONNECTION);localStorage.clear();mocks.api.mockReset();});

describe('character review outbox',()=>{
  it('keeps one durable intent per pair and replaces it under a new id',()=>{
    const first=decide('a');
    expect(JSON.parse(localStorage.getItem(outboxKey('lakomics.characters.review.outbox.v1')!)!)['c:a'].operationId).toBe(first.operationId);
    const second=decide('a','rejected');
    expect(second.operationId).not.toBe(first.operationId);
    expect(Object.keys(readReviewIntents())).toEqual(['c:a']);
    expect(queuedReviewPairs()).toEqual(new Set(['c:a']));
  });
  it('removes an unsent decision on undo and queues cleared for a sent or in-flight one',()=>{
    const first=decide('a');
    expect(undoReviewDecision(first)).toBe('removed');
    expect(readReviewIntents()).toEqual({});
    // Already confirmed (no longer queued): the server may hold it, so undo sends `cleared`.
    const sentOne=decide('b');localStorage.clear();
    expect(undoReviewDecision(sentOne)).toBe('cleared');
    const cleared=readReviewIntents()['c:b'];
    expect([cleared.decision,cleared.operationId===sentOne.operationId,cleared.basis]).toEqual(['cleared',false,null]);
    // `cleared` does not hide the pair locally: the candidate may show again.
    expect(queuedReviewPairs().size).toBe(0);
    const flying=decide('c');
    expect(undoReviewDecision(flying,id=>id===flying.operationId)).toBe('cleared');
    expect(readReviewIntents()['c:c'].decision).toBe('cleared');
  });
  it('refuses more than the outbox limit of waiting pairs',()=>{
    const intents=Object.fromEntries(Array.from({length:REVIEW_OUTBOX_LIMIT},(_,i)=>[`c:x${i}`,{libraryId:LIBRARY,targetId:'c',assetId:`x${i}`,decision:'accepted',origin:'feed',basis:null,operationId:`op${i}`,createdAt:i}]));
    localStorage.setItem(outboxKey('lakomics.characters.review.outbox.v1')!,JSON.stringify(intents));
    expect(()=>decide('new')).toThrow(REVIEW_OUTBOX_FULL);
    expect(decide('x3','rejected').decision).toBe('rejected');
  });
});

describe('character review delivery',()=>{
  it('sends the minted id, keeps it on transport failure and removes it on receipt',async()=>{
    const intent=decide('a');
    install(()=>new ApiError('offline',null,null));
    await expect(flushCharacterReview()).rejects.toThrow('offline');
    expect(readReviewIntents()['c:a'].operationId).toBe(intent.operationId);
    install(body=>({operationId:body.operationId,sequence:1,revision:'r',pendingPc:true}));
    const report=await flushCharacterReview();
    expect(report.outcomes).toEqual([{key:'c:a',outcome:'confirmed'}]);
    expect(sent().map(body=>body.operationId)).toEqual([intent.operationId,intent.operationId]);
    expect(sent()[1]).toEqual({version:1,libraryId:LIBRARY,operationId:intent.operationId,targetId:'c',assetId:'a',decision:'accepted',origin:'feed',basis:'b1'});
    expect(readReviewIntents()).toEqual({});
    expect(isReviewInFlight(intent.operationId)).toBe(false);
  });
  it('waits while no PC adopted review',async()=>{
    decide('a');
    install(()=>{throw new Error('must not send');},{...ready,ready:false});
    const report=await flushCharacterReview();
    expect(report.unsupported).toBe(true);
    expect(sent()).toEqual([]);
    expect(Object.keys(readReviewIntents())).toEqual(['c:a']);
  });
  it('drops permanent refusals, defers a pending exclusion and reissues a reused id once',async()=>{
    decide('gone');decide('excluded');const reused=decide('reused');
    install(body=>{
      if(body.assetId==='gone')return refused('characterReviewAssetMissing');
      if(body.assetId==='excluded')return refused('pendingCharacterCorrection');
      if(body.operationId===reused.operationId)return refused('operationConflict');
      return {operationId:body.operationId};
    });
    const report=await flushCharacterReview();
    const byKey=Object.fromEntries(report.outcomes.map(o=>[o.key,o]));
    expect(byKey['c:gone'].outcome).toBe('rejected');
    expect(byKey['c:gone'].message).toContain('자산');
    expect(byKey['c:excluded'].outcome).toBe('deferred');
    expect(byKey['c:reused'].outcome).toBe('confirmed');
    expect(Object.keys(readReviewIntents())).toEqual(['c:excluded']);
    expect(sent().filter(body=>body.assetId==='reused')).toHaveLength(2);
  });
});

describe('character review connection identity',()=>{
  it('keeps A\'s decisions away from B, keeps another library\'s queued, and sends them back on A',async()=>{
    const intent=decide('a');
    setOutboxConnection('https://b.example');
    install(()=>{throw new Error('must not send');});
    expect(readReviewIntents()).toEqual({});
    expect(await flushCharacterReview()).toEqual({outcomes:[],unsupported:false});
    expect(mocks.api).not.toHaveBeenCalled();
    setOutboxConnection(CONNECTION);
    // A reports another library now: kept, not sent under it and not dropped.
    install(()=>{throw new Error('must not send');},{...ready,libraryId:'f'.repeat(32)});
    expect((await flushCharacterReview()).outcomes).toEqual([{key:'c:a',outcome:'suspended'}]);
    // The server refusing the library is not a drop either.
    install(()=>refused('libraryMismatch'));
    expect((await flushCharacterReview()).outcomes).toEqual([{key:'c:a',outcome:'suspended'}]);
    expect(readReviewIntents()['c:a'].operationId).toBe(intent.operationId);
    install(body=>({operationId:body.operationId}));
    expect((await flushCharacterReview()).outcomes).toEqual([{key:'c:a',outcome:'confirmed'}]);
    expect(mocks.api.mock.calls.every(call=>call[5]===CONNECTION)).toBe(true);
  });
});
