import {beforeEach,describe,expect,it,vi} from 'vitest';
import {outboxKey,setOutboxConnection} from './outboxConnection';
const CONNECTION='https://a.example';

const mocks=vi.hoisted(()=>({native:vi.fn()}));
vi.mock('./transport',async()=>{
  const actual=await vi.importActual<typeof import('./transport')>('./transport');
  return {...actual,native:mocks.native};
});

import {flushBookmarkIntents} from './bookmarkDelivery';
import {ApiError} from './transport';
import {commitBookmarkIntent,readIntent,readIntents,recordConfirmed} from './bookmarkOutbox';

const LIBRARY='a'.repeat(32);
const epoch=1;
const authority={libraryId:LIBRARY,epoch,contractVersion:1};

/** The `/status` reply a server that advertises the write capability returns. */
function status(write=true,overrides:Record<string,unknown>={}){
  return {authorityLibraryId:LIBRARY,authorityEpoch:epoch,authorityContractVersion:1,capabilities:{bookmarkWrite:write},...overrides};
}
function commandResult(overrides:Record<string,unknown>={}){
  return {libraryId:LIBRARY,epoch,contractVersion:1,provider:'kHentai',providerWorkId:'42',desiredState:true,entityRevision:1,changed:true,...overrides};
}
/** What the native bridge returns for a recoverable `revisionConflict`. */
function conflict(revision:number,desired:boolean){
  return {conflict:{revision,desiredState:desired}};
}
/** The raw server 409 body, when an ApiError carries it unwrapped. */
function rawConflict(revision:number,desired:boolean){
  return new ApiError('서버가 요청을 처리하지 못했습니다.',409,{detail:{code:'revisionConflict',authorityCursor:revision,current:{provider:'kHentai',workId:'42',desiredState:desired,entityRevision:revision,createdAt:null,updatedAt:null}}});
}
/** A 409 without the conflict detail: identity skew, which is not recoverable. */
function identityMismatch(){
  return new ApiError('서버가 요청을 처리하지 못했습니다.',409,{detail:{code:'authorityMismatch',current:{entityRevision:4,desiredState:true}}});
}

function install(handlers:{status?:unknown;command?:unknown}){
  mocks.native.mockImplementation(async(operation:string,payload:Record<string,unknown>)=>{
    if(payload.path==='/v1/mobile-catalog/status')return handlers.status ?? status();
    if(operation==='bookmarkCommand'){
      const answer=handlers.command;
      if(answer instanceof Error)throw answer;
      return answer ?? commandResult();
    }
    throw new Error(`unexpected ${operation}`);
  });
}

/** The commands a run actually sent, in order. */
function sent(){
  return mocks.native.mock.calls.filter(([operation])=>operation==='bookmarkCommand').map(([,payload])=>payload as Record<string,unknown>);
}

beforeEach(()=>{setOutboxConnection(CONNECTION);localStorage.clear();mocks.native.mockReset();});

describe('mobile bookmark delivery',()=>{
  it('confirms a successful add and records the authoritative revision',async()=>{
    commitBookmarkIntent('kHentai','42',true,authority);
    install({command:commandResult({entityRevision:4})});
    const report=await flushBookmarkIntents();
    expect(report.outcomes).toEqual([{providerWorkId:'42',outcome:'confirmed'}]);
    expect(Object.keys(readIntents())).toHaveLength(0);
    // The next mutation composes its base from the confirmed revision.
    expect(commitBookmarkIntent('kHentai','42',false,authority).baseRevision).toBe(4);
  });

  it('sends the exact B4 command body from the durable intent',async()=>{
    const intent=commitBookmarkIntent('kHentai','42',true,authority);
    install({});
    await flushBookmarkIntents();
    expect(sent()[0]).toMatchObject({
      provider:'kHentai',providerWorkId:'42',libraryId:LIBRARY,epoch,
      contractVersion:1,operationId:intent.operationId,expectedRevision:0,desiredState:true,
    });
  });

  it('treats an already-current state as confirmed rather than a failure',async()=>{
    commitBookmarkIntent('kHentai','42',true,authority);
    install({command:commandResult({changed:false,entityRevision:2})});
    const report=await flushBookmarkIntents();
    expect(report.outcomes[0].outcome).toBe('already-current');
    expect(Object.keys(readIntents())).toHaveLength(0);
  });

  it('retries a lost response with the same operation id and keeps one logical mutation',async()=>{
    const intent=commitBookmarkIntent('kHentai','42',true,authority);
    // The server accepted the command and the response was lost: the client sees a
    // transport failure, not a rejection.
    install({command:new ApiError('서버에 연결할 수 없습니다.',null,null)});
    await expect(flushBookmarkIntents()).rejects.toThrow();
    expect(readIntent('kHentai','42')?.operationId).toBe(intent.operationId);

    // The retry carries the identical operation id, so the server's B4 receipt
    // resolves it instead of recording a second logical write.
    install({command:commandResult({entityRevision:1})});
    const report=await flushBookmarkIntents();
    expect(report.outcomes[0].outcome).toBe('confirmed');
    const commands=sent();
    expect(commands).toHaveLength(2);
    expect(commands[0].operationId).toBe(commands[1].operationId);
  });

  it('survives a restart with the same operation id',async()=>{
    const intent=commitBookmarkIntent('kHentai','42',true,authority);
    // A restart re-reads the durable store; nothing survives only in memory.
    expect(readIntent('kHentai','42')?.operationId).toBe(intent.operationId);
    install({});
    await flushBookmarkIntents();
    expect(sent()[0].operationId).toBe(intent.operationId);
  });

  it('completes a stale intent when the authority already holds the desired state',async()=>{
    const intent=commitBookmarkIntent('kHentai','42',true,authority);
    install({command:conflict(3,true)});
    const report=await flushBookmarkIntents();
    expect(report.outcomes[0].outcome).toBe('already-current');
    expect(Object.keys(readIntents())).toHaveLength(0);
    // No second command: the authority already had the requested state.
    expect(sent()).toHaveLength(1);
    expect(sent()[0].operationId).toBe(intent.operationId);
  });

  it('re-bases a stale intent and retries it under the same operation id',async()=>{
    const intent=commitBookmarkIntent('kHentai','42',true,authority);
    let attempts=0;
    mocks.native.mockImplementation(async(operation:string,payload:Record<string,unknown>)=>{
      if(payload.path==='/v1/mobile-catalog/status')return status();
      attempts+=1;
      if(attempts===1)return conflict(5,false);
      return commandResult({entityRevision:6});
    });
    const report=await flushBookmarkIntents();
    expect(report.outcomes[0].outcome).toBe('confirmed');
    const commands=sent();
    expect(commands).toHaveLength(2);
    expect(commands[0].expectedRevision).toBe(0);
    expect(commands[1].expectedRevision).toBe(5);
    expect(commands[0].operationId).toBe(intent.operationId);
    expect(commands[1].operationId).toBe(intent.operationId);
  });

  it('keeps the intent queued when a second conflict shows another writer racing',async()=>{
    commitBookmarkIntent('kHentai','42',true,authority);
    install({command:conflict(5,false)});
    const report=await flushBookmarkIntents();
    // The intent survives with its identity, so a later pass settles it rather
    // than the client thrashing or dropping the user's decision.
    expect(report.outcomes[0].outcome).toBe('deferred');
    expect(readIntent('kHentai','42')).not.toBeNull();
  });

  it('does not let a late response clear a newer intent',async()=>{
    const first=commitBookmarkIntent('kHentai','42',true,authority);
    const firstReply=Promise.withResolvers<unknown>();
    mocks.native.mockImplementation(async(operation:string,payload:Record<string,unknown>)=>{
      if(payload.path==='/v1/mobile-catalog/status')return status();
      return firstReply.promise;
    });
    const pending=flushBookmarkIntents();
    // Wait until the first command is genuinely in flight before superseding it.
    await vi.waitFor(()=>expect(sent()).toHaveLength(1));
    // The user changes their mind before the first response arrives.
    const second=commitBookmarkIntent('kHentai','42',false,authority);
    expect(second.operationId).not.toBe(first.operationId);
    firstReply.resolve(commandResult({entityRevision:9,desiredState:false,changed:true}));
    const report=await pending;
    expect(report.outcomes[0].outcome).toBe('superseded');
    // The newer intent is intact, and the stale revision was not recorded over it.
    expect(readIntent('kHentai','42')?.operationId).toBe(second.operationId);
    expect(readIntent('kHentai','42')?.desired).toBe(false);
    expect(readIntent('kHentai','42')?.baseRevision).toBe(0);
  });

  it('sends nothing while the write capability is not advertised, and keeps the intent',async()=>{
    commitBookmarkIntent('kHentai','42',true,authority);
    install({status:status(false)});
    const report=await flushBookmarkIntents();
    expect(report.authorityUnavailable).toBe(true);
    expect(report.outcomes).toEqual([{providerWorkId:'42',outcome:'withheld'}]);
    expect(sent()).toHaveLength(0);
    expect(readIntent('kHentai','42')).not.toBeNull();
  });

  it('sends nothing while the domain is still PC-owned',async()=>{
    commitBookmarkIntent('kHentai','42',true,authority);
    install({status:{authorityLibraryId:null,authorityEpoch:null,authorityContractVersion:null,capabilities:{bookmarkWrite:false}}});
    const report=await flushBookmarkIntents();
    expect(report.authorityUnavailable).toBe(true);
    expect(sent()).toHaveLength(0);
    expect(readIntent('kHentai','42')).not.toBeNull();
  });

  it('keeps the intent when authentication fails',async()=>{
    commitBookmarkIntent('kHentai','42',true,authority);
    install({command:new ApiError('인증에 실패했습니다. 토큰을 확인해 주세요.',401,null)});
    await expect(flushBookmarkIntents()).rejects.toThrow();
    expect(readIntent('kHentai','42')).not.toBeNull();
    expect(sent()).toHaveLength(1);
  });

  it('keeps the intent on a server rejection',async()=>{
    commitBookmarkIntent('kHentai','42',true,authority);
    install({command:new ApiError('서버가 요청을 처리하지 못했습니다.',500,null)});
    await expect(flushBookmarkIntents()).rejects.toThrow();
    expect(readIntent('kHentai','42')).not.toBeNull();
  });

  it('does not falsely confirm on an identity mismatch',async()=>{
    const intent=commitBookmarkIntent('kHentai','42',true,authority);
    install({command:identityMismatch()});
    await expect(flushBookmarkIntents()).rejects.toThrow();
    // A 409 without the conflict detail is identity skew, not a confirmation.
    expect(readIntent('kHentai','42')?.operationId).toBe(intent.operationId);
    expect(Object.keys(readIntents())).toHaveLength(1);
  });

  it('sends an intent composed under another epoch with a zero base',async()=>{
    // The intent was queued under epoch 1; the authority has since advanced.
    commitBookmarkIntent('kHentai','42',true,authority);
    recordConfirmed('kHentai','42',1,7,true);
    install({status:status(true,{authorityEpoch:2})});
    await flushBookmarkIntents();
    expect(sent()[0]).toMatchObject({epoch:2,expectedRevision:0});
  });

  it('processes pending intents oldest first',async()=>{
    const first=commitBookmarkIntent('kHentai','1',true,authority);
    const intents=readIntents();
    intents['kHentai:1'].createdAt=1000;
    intents['kHentai:2']={...first,providerWorkId:'2',operationId:crypto.randomUUID(),createdAt:500};
    localStorage.setItem(outboxKey('lakomics.catalog.bookmarks.outbox.v1')!,JSON.stringify(intents));
    install({});
    await flushBookmarkIntents();
    expect(sent().map(command=>command.providerWorkId)).toEqual(['2','1']);
  });
});

describe('conflict carrier shapes',()=>{
  it('accepts the raw server conflict body as well as the bridge-wrapped reply',async()=>{
    commitBookmarkIntent('kHentai','42',true,authority);
    install({command:rawConflict(6,false)});
    const report=await flushBookmarkIntents();
    // The intent is re-based and retried under its own operation id, not dropped.
    // The second attempt conflicts again, so it is left queued rather than thrashed.
    expect(report.outcomes[0].outcome).toBe('deferred');
    expect(sent().map(command=>command.expectedRevision)).toEqual([0,6]);
    expect(sent()[0].operationId).toBe(sent()[1].operationId);
    expect(readIntent('kHentai','42')?.baseRevision).toBe(6);
  });

  it('does not treat an unrelated 409 as a recoverable conflict',async()=>{
    commitBookmarkIntent('kHentai','42',true,authority);
    install({command:identityMismatch()});
    await expect(flushBookmarkIntents()).rejects.toThrow();
    expect(readIntent('kHentai','42')?.baseRevision).toBe(0);
  });
});

describe('mobile bookmark connection identity',()=>{
  it('keeps A\'s intents away from B and never re-points one at another library',async()=>{
    const intent=commitBookmarkIntent('kHentai','42',true,authority);
    setOutboxConnection('https://b.example');
    install({});
    expect(readIntents()).toEqual({});
    expect((await flushBookmarkIntents()).outcomes).toEqual([]);
    expect(sent()).toEqual([]);
    setOutboxConnection(CONNECTION);
    // A now reports another library: the intent waits instead of being sent under it.
    install({status:status(true,{authorityLibraryId:'b'.repeat(32)})});
    expect((await flushBookmarkIntents()).outcomes).toEqual([{providerWorkId:'42',outcome:'suspended'}]);
    expect(sent()).toEqual([]);
    mocks.native.mockClear();
    install({});
    expect((await flushBookmarkIntents()).outcomes).toEqual([{providerWorkId:'42',outcome:'confirmed'}]);
    expect(sent()).toEqual([expect.objectContaining({operationId:intent.operationId,libraryId:LIBRARY,connection:CONNECTION})]);
    // The status read is guarded by the same connection.
    expect(mocks.native.mock.calls.filter(([,payload])=>(payload as {path?:string}).path)
      .every(([,payload])=>(payload as {connection?:string}).connection===CONNECTION)).toBe(true);
  });
});
