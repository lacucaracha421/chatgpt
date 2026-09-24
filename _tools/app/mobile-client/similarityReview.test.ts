import {beforeEach,describe,expect,it,vi} from 'vitest';

const mocks=vi.hoisted(()=>({api:vi.fn()}));
vi.mock('./transport',async()=>{
  const actual=await vi.importActual<typeof import('./transport')>('./transport');
  return {...actual,api:mocks.api};
});

import {ApiError} from './transport';
import {SIMILARITY_DECISIONS_PATH,flushSimilarityReview} from './similarityReviewDelivery';
import {SIMILARITY_OUTBOX_FULL,SIMILARITY_OUTBOX_LIMIT,SIMILARITY_SEND_DELAY_MS,commitSimilarityDecision,nextSimilarityDue,queuedSimilarity,readSimilarityIntents,undoSimilarityDecision,type SimilarityChoice} from './similarityReviewOutbox';
import {FIT,fitted,transformFor} from './SimilarityReview';

const LIBRARY='e'.repeat(32),SHA='a'.repeat(64),REV='f'.repeat(64);
const ready={version:1,ready:true,libraryId:LIBRARY,revision:REV,counts:{open:0,pendingPc:0,skipped:0},items:[],nextCursor:null,hasMore:false};
type Body={operationId:string;reviewId:string;decision:string;basis:unknown;libraryId:string;version:number};
const refused=(code:string,status=409)=>new ApiError('refused',status,{detail:{code,message:'m'}});
function install(command:(body:Body)=>unknown,feed:unknown=ready){
  mocks.api.mockImplementation(async(path:string,_signal:unknown,body?:Body)=>{
    if(path.startsWith('/v1/library/similarity/review?'))return feed;
    if(path===SIMILARITY_DECISIONS_PATH&&body){const reply=command(body);if(reply instanceof Error)throw reply;return reply;}
    throw new Error('unexpected '+path);
  });
}
const sent=()=>mocks.api.mock.calls.filter(([path])=>path===SIMILARITY_DECISIONS_PATH).map(([, ,body])=>body as Body);
const decide=(reviewId:string,decision:SimilarityChoice='keep_existing',a='a',b='b',now=1000)=>
  commitSimilarityDecision({libraryId:LIBRARY,reviewId,decision,basis:{feedRevision:REV,aSha256:SHA,bSha256:SHA},aAssetId:a,bAssetId:b},undefined,now);
const later=()=>Date.now()+SIMILARITY_SEND_DELAY_MS+1;

beforeEach(()=>{localStorage.clear();mocks.api.mockReset();});

describe('similarity review outbox',()=>{
  it('keeps one delayed intent per review and tracks the images it will trash',()=>{
    const first=decide('r1','keep_existing','a','b',1000);
    expect(first.notBefore).toBe(1000+SIMILARITY_SEND_DELAY_MS);
    expect(nextSimilarityDue()).toBe(6000);
    decide('r2','replace_existing','c','d');
    decide('r3','keep_both','e','f');
    expect(queuedSimilarity()).toEqual({reviews:new Set(['r1','r2','r3']),trashed:new Set(['b','c'])});
    const replaced=decide('r1','keep_both');
    expect(replaced.operationId).not.toBe(first.operationId);
    expect(Object.keys(readSimilarityIntents()).sort()).toEqual(['r1','r2','r3']);
  });
  it('undo removes an unsent intent and withdraws a sent or in-flight one under its own key',()=>{
    const first=decide('r1');
    expect(undoSimilarityDecision(first)).toBe('removed');
    expect(readSimilarityIntents()).toEqual({});
    const sentOne=decide('r2');localStorage.clear();
    expect(undoSimilarityDecision(sentOne,undefined,undefined,5000)).toBe('withdrawn');
    const withdrawn=readSimilarityIntents()['r2:withdrawn'];
    expect([withdrawn.decision,withdrawn.notBefore,withdrawn.operationId===sentOne.operationId]).toEqual(['withdrawn',5000,false]);
    // A withdrawal does not hide the pair, and a new decision does not replace it.
    expect(queuedSimilarity().reviews.size).toBe(0);
    decide('r2','keep_both');
    expect(Object.keys(readSimilarityIntents()).sort()).toEqual(['r2','r2:withdrawn']);
    const flying=decide('r3');
    expect(undoSimilarityDecision(flying,id=>id===flying.operationId)).toBe('withdrawn');
    expect(readSimilarityIntents()['r3']).toBeUndefined();
    expect(readSimilarityIntents()['r3:withdrawn'].decision).toBe('withdrawn');
  });
  it('refuses more than the outbox limit',()=>{
    const intents=Object.fromEntries(Array.from({length:SIMILARITY_OUTBOX_LIMIT},(_,i)=>[`x${i}`,{libraryId:LIBRARY,reviewId:`x${i}`,decision:'keep_both',basis:{feedRevision:REV,aSha256:SHA,bSha256:SHA},aAssetId:'a',bAssetId:'b',operationId:`op${i}`,createdAt:i,notBefore:i}]));
    localStorage.setItem('lakomics.similarity.review.outbox.v1',JSON.stringify(intents));
    expect(()=>decide('new')).toThrow(SIMILARITY_OUTBOX_FULL);
    expect(decide('x3','keep_existing').decision).toBe('keep_existing');
  });
});

describe('similarity review delivery',()=>{
  it('waits out the undo window, then sends the minted id and removes it on receipt',async()=>{
    const intent=decide('r1','keep_existing','a','b',Date.now());
    install(body=>({operationId:body.operationId,sequence:1,pendingPc:true}));
    expect((await flushSimilarityReview()).outcomes).toEqual([]);
    expect(sent()).toEqual([]);
    install(()=>new ApiError('offline',null,null));
    await expect(flushSimilarityReview(undefined,later)).rejects.toThrow('offline');
    expect(readSimilarityIntents()['r1'].operationId).toBe(intent.operationId);
    install(body=>({operationId:body.operationId,sequence:1,pendingPc:true}));
    expect((await flushSimilarityReview(undefined,later)).outcomes).toEqual([{key:'r1',outcome:'confirmed'}]);
    expect(sent()[1]).toEqual({version:1,libraryId:LIBRARY,operationId:intent.operationId,reviewId:'r1',decision:'keep_existing',basis:{feedRevision:REV,aSha256:SHA,bSha256:SHA}});
    expect(readSimilarityIntents()).toEqual({});
  });
  it('sends a withdrawal before a newer decision on the same review',async()=>{
    const made=decide('r1');localStorage.clear();
    undoSimilarityDecision(made,undefined,undefined,1);
    decide('r1','keep_both','a','b',2);
    install(body=>({operationId:body.operationId}));
    await flushSimilarityReview(undefined,later);
    expect(sent().map(body=>body.decision)).toEqual(['withdrawn','keep_both']);
  });
  it('waits while no PC adopted review',async()=>{
    decide('r1','keep_existing','a','b',0);
    install(()=>{throw new Error('must not send');},{...ready,ready:false});
    const report=await flushSimilarityReview(undefined,later);
    expect(report.unsupported).toBe(true);
    expect(sent()).toEqual([]);
  });
  it('drops permanent refusals, defers pending conflicts and reissues a reused id once',async()=>{
    decide('gone','keep_existing','a','b',0);decide('busy','keep_existing','c','d',0);const reused=decide('reused','keep_both','e','f',0);
    const applied=decide('applied','keep_existing','g','h',0);localStorage.clear();
    decide('gone','keep_existing','a','b',0);decide('busy','keep_existing','c','d',0);
    localStorage.setItem('lakomics.similarity.review.outbox.v1',JSON.stringify({...readSimilarityIntents(),reused}));
    undoSimilarityDecision(applied,undefined,undefined,0);
    install(body=>{
      if(body.reviewId==='gone')return refused('similarityAssetChanged');
      if(body.reviewId==='busy')return refused('similarityAssetPendingTrash');
      if(body.reviewId==='applied')return refused('similarityDecisionApplied');
      if(body.operationId===reused.operationId)return refused('operationConflict');
      return {operationId:body.operationId};
    });
    const report=await flushSimilarityReview(undefined,later);
    const byKey=Object.fromEntries(report.outcomes.map(o=>[o.key,o]));
    expect(byKey['gone'].outcome).toBe('rejected');
    expect(byKey['busy'].outcome).toBe('deferred');
    expect(byKey['applied:withdrawn'].message).toContain('휴지통에서 복원');
    expect(byKey['reused'].outcome).toBe('confirmed');
    expect(Object.keys(readSimilarityIntents())).toEqual(['busy']);
  });
});

describe('synced compare view',()=>{
  it('puts the same normalized point at the centre of differently sized images',()=>{
    const box={width:400,height:400};
    expect(fitted(box,{width:2000,height:1000})).toEqual({width:400,height:200});
    expect(transformFor(FIT,box,{width:2000,height:1000})).toBe('translate(0px, 0px) scale(1)');
    const view={scale:4,x:0.75,y:0.25};
    // A 2000×1000 image and its 1000×500 downscale are displayed the same size, so they line up.
    expect(transformFor(view,box,{width:2000,height:1000})).toBe(transformFor(view,box,{width:1000,height:500}));
    expect(transformFor(view,box,{width:2000,height:1000})).toBe('translate(-400px, 200px) scale(4)');
  });
});
