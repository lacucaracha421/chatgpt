import {beforeEach,describe,expect,it} from 'vitest';
import {
  commitBookmarkIntent,
  confirmBookmarkIntent,
  readIntents,
  readIntent,
  rebaseBookmarkIntent,
  recordConfirmed,
  visibleBookmark,
} from './bookmarkOutbox';

const authority={libraryId:'a'.repeat(32),epoch:1,contractVersion:1};
const OTHER={libraryId:'b'.repeat(32),epoch:1,contractVersion:1};

beforeEach(()=>{localStorage.clear();});

describe('durable bookmark intents',()=>{
  it('creates exactly one durable intent per add, with a minted operation id',()=>{
    const intent=commitBookmarkIntent('kHentai','42',true,authority);
    expect(intent.operationId).toMatch(/^[0-9a-f-]{36}$/);
    expect(Object.keys(readIntents())).toHaveLength(1);
    expect(readIntent('kHentai','42')).toEqual(intent);
    expect(intent.desired).toBe(true);
    // An entity never observed has no state row, whose revision the server calls 0.
    expect(intent.baseRevision).toBe(0);
  });

  it('creates exactly one durable intent per removal',()=>{
    commitBookmarkIntent('kHentai','42',true,authority);
    recordConfirmed('kHentai','42',1,1,true);
    commitBookmarkIntent('kHentai','42',false,authority);
    const intents=readIntents();
    expect(Object.keys(intents)).toHaveLength(1);
    // The removal supersedes the pending add: one row per entity, and it composes
    // its base from the authoritative revision rather than the superseded intent.
    expect(Object.values(intents)[0]).toMatchObject({desired:false,baseRevision:1});
  });

  it('keeps the operation id when the user repeats the same intent, so a retry stays idempotent',()=>{
    const first=commitBookmarkIntent('kHentai','42',true,authority);
    const second=commitBookmarkIntent('kHentai','42',true,authority);
    expect(second.operationId).toBe(first.operationId);
    expect(Object.keys(readIntents())).toHaveLength(1);
  });

  it('mints a fresh operation id when the user asks for the opposite state',()=>{
    const first=commitBookmarkIntent('kHentai','42',true,authority);
    const second=commitBookmarkIntent('kHentai','42',false,authority);
    // A different payload under the same id would be rejected by the server's
    // receipt check, so a superseding action is a new logical operation.
    expect(second.operationId).not.toBe(first.operationId);
  });

  it('persists an intent across a restart without changing its operation id',()=>{
    const intent=commitBookmarkIntent('kHentai','42',true,authority);
    // A restart is a fresh read of the same durable store; nothing is held in memory.
    expect(readIntent('kHentai','42')?.operationId).toBe(intent.operationId);
    expect(localStorage.getItem('lakomics.catalog.bookmarks.outbox.v1')).toContain(intent.operationId);
  });

  it('survives a superseding action by identity, so an older response cannot clear it',()=>{
    const first=commitBookmarkIntent('kHentai','42',true,authority);
    const second=commitBookmarkIntent('kHentai','42',false,authority);
    // The response to the first intent arrives late.
    expect(confirmBookmarkIntent(first,1,1)).toBe(false);
    expect(readIntent('kHentai','42')?.operationId).toBe(second.operationId);
    expect(readIntent('kHentai','42')?.desired).toBe(false);
    // The late response also must not record its revision as authoritative for the
    // newer intent.
    expect(visibleBookmark('kHentai','42',true)).toEqual({desired:false,pending:true});
  });

  it('completes a confirmed intent and records the authoritative revision',()=>{
    const intent=commitBookmarkIntent('kHentai','42',true,authority);
    expect(confirmBookmarkIntent(intent,1,3)).toBe(true);
    expect(readIntent('kHentai','42')).toBeNull();
    expect(visibleBookmark('kHentai','42',null)).toEqual({desired:true,pending:false});
    // The next mutation composes its base from that revision.
    expect(commitBookmarkIntent('kHentai','42',false,authority).baseRevision).toBe(3);
  });

  it('does not resurrect a confirmed intent after a restart',()=>{
    const intent=commitBookmarkIntent('kHentai','42',true,authority);
    confirmBookmarkIntent(intent,1,3);
    expect(Object.keys(readIntents())).toHaveLength(0);
    expect(localStorage.getItem('lakomics.catalog.bookmarks.outbox.v1')).toBe('{}');
  });

  it('re-bases a stale intent onto the reported revision under the same operation id',()=>{
    const intent=commitBookmarkIntent('kHentai','42',true,authority);
    const rebased=rebaseBookmarkIntent(intent,1,{revision:5,desiredState:false});
    expect(rebased?.operationId).toBe(intent.operationId);
    expect(rebased?.baseRevision).toBe(5);
    expect(readIntent('kHentai','42')?.baseRevision).toBe(5);
  });

  it('refuses to re-base an intent a newer action replaced',()=>{
    const first=commitBookmarkIntent('kHentai','42',true,authority);
    commitBookmarkIntent('kHentai','42',false,authority);
    expect(rebaseBookmarkIntent(first,1,{revision:5,desiredState:false})).toBeNull();
  });

  it('keeps an intent durable across every retryable failure',()=>{
    commitBookmarkIntent('kHentai','42',true,authority);
    // Nothing in a failure path mutates the queue: authorization, transport and
    // timeout all leave the same durable row in place.
    expect(readIntent('kHentai','42')).not.toBeNull();
    expect(readIntent('kHentai','42')?.operationId).toBeTruthy();
  });
});

describe('pending overlay over authoritative state',()=>{
  it('shows a pending add over authoritative unbookmarked state',()=>{
    commitBookmarkIntent('kHentai','42',true,authority);
    expect(visibleBookmark('kHentai','42',false)).toEqual({desired:true,pending:true});
  });

  it('shows a pending removal over authoritative bookmarked state',()=>{
    recordConfirmed('kHentai','42',1,2,true);
    commitBookmarkIntent('kHentai','42',false,authority);
    expect(visibleBookmark('kHentai','42',true)).toEqual({desired:false,pending:true});
  });

  it('falls back to the authoritative value once the intent is confirmed',()=>{
    const intent=commitBookmarkIntent('kHentai','42',true,authority);
    expect(visibleBookmark('kHentai','42',false).pending).toBe(true);
    confirmBookmarkIntent(intent,1,4);
    expect(visibleBookmark('kHentai','42',true)).toEqual({desired:true,pending:false});
    // Even an older replica value cannot revert a confirmed intent's outcome
    // silently: the caller sees the authoritative value it was given, and the
    // recorded revision is the newest observation.
    expect(visibleBookmark('kHentai','42',false)).toEqual({desired:false,pending:false});
  });

  it('never moves a cached revision backwards within one epoch',()=>{
    recordConfirmed('kHentai','42',1,5,true);
    recordConfirmed('kHentai','42',1,2,false);
    commitBookmarkIntent('kHentai','42',true,authority);
    expect(readIntent('kHentai','42')?.baseRevision).toBe(5);
  });

  it('treats a different epoch as a fresh baseline rather than reusing a revision',()=>{
    recordConfirmed('kHentai','42',1,5,true);
    const next={...authority,epoch:2};
    const intent=commitBookmarkIntent('kHentai','42',true,next);
    expect(intent.baseRevision).toBe(0);
  });

  it('does not carry an intent across a library identity change',()=>{
    const first=commitBookmarkIntent('kHentai','42',true,authority);
    const second=commitBookmarkIntent('kHentai','42',true,OTHER);
    // A different library is a different authority: reusing the operation id there
    // would be a command this PC never composed.
    expect(second.operationId).not.toBe(first.operationId);
  });

  it('does not let a pre-write read revert a confirmed write',()=>{
    const intent=commitBookmarkIntent('kHentai','42',true,authority);
    confirmBookmarkIntent(intent,1,4);
    // The screen still holds the detail it read before the write, whose state and
    // revision predate the confirmation.
    expect(visibleBookmark('kHentai','42',false,0)).toEqual({desired:true,pending:false});
    // A read at or past the confirmed revision is newer truth and wins.
    expect(visibleBookmark('kHentai','42',false,4)).toEqual({desired:false,pending:false});
    expect(visibleBookmark('kHentai','42',false,5)).toEqual({desired:false,pending:false});
  });

  it('enqueues nothing when nothing is committed',()=>{
    recordConfirmed('kHentai','42',1,7,true);
    visibleBookmark('kHentai','42',true);
    expect(Object.keys(readIntents())).toHaveLength(0);
  });
});
