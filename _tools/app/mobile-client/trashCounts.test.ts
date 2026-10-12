import {beforeEach,expect,it,vi} from 'vitest';
import type {NotesStore} from '../src/notes/store';
const mocks=vi.hoisted(()=>({api:vi.fn()}));
vi.mock('./transport',()=>({api:mocks.api}));
import {readTabletTrashCount} from './trashCounts';
const identity={libraryId:'a'.repeat(32),epoch:1,contractVersion:1};
let notes:{ready:boolean;unlocked:boolean;error:string|null;notes:unknown[]};
const store={refresh:vi.fn(async()=>{}),snapshot:()=>notes} as unknown as NotesStore;
beforeEach(()=>{
  notes={ready:true,unlocked:true,error:null,notes:[]};
  vi.mocked(store.refresh).mockReset().mockResolvedValue();
  mocks.api.mockReset().mockImplementation(async(path:string)=>path.includes('/status')?{...identity,active:true}:path.includes('/collections/')?{...identity,items:[{}]}:{active:true,total_count:7});
});
it('reads all sections afresh instead of using a partial session total',async()=>{
  expect(await readTabletTrashCount('https://fresh.example',store,new AbortController().signal)).toBe(8);
  expect(store.refresh).toHaveBeenCalledOnce();
  expect(mocks.api.mock.calls.every(call=>call[5]==='https://fresh.example')).toBe(true);
});
it('waits for notes before exposing the total',async()=>{
  let finish!:()=>void;
  vi.mocked(store.refresh).mockImplementation(()=>new Promise<void>(resolve=>{finish=resolve;}));
  const done=vi.fn();
  const read=readTabletTrashCount('https://fresh.example',store,new AbortController().signal).then(done);
  await Promise.resolve();expect(done).not.toHaveBeenCalled();
  finish();await read;expect(done).toHaveBeenCalledWith(8);
});
it.each(['failed','locked','paginated','wrong-library','aborted'])('omits an unknown total: %s',async(reason)=>{
  const controller=new AbortController();
  if(reason==='failed')mocks.api.mockRejectedValue(new Error('offline'));
  if(reason==='locked')notes.unlocked=false;
  if(reason==='paginated')mocks.api.mockImplementation(async(path:string)=>path.includes('/status')?{...identity,active:true}:path.includes('/collections/')?{...identity,items:[{}],hasMore:true}:{active:true,total_count:7});
  if(reason==='wrong-library')mocks.api.mockImplementation(async(path:string)=>path.includes('/status')?{...identity,active:true}:path.includes('/collections/')?{...identity,epoch:2,items:[{}]}:{active:true,total_count:7});
  if(reason==='aborted')controller.abort();
  expect(await readTabletTrashCount('https://fresh.example',store,controller.signal)).toBeNull();
});
