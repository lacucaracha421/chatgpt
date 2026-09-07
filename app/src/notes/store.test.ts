import { afterEach, expect, it, vi } from "vitest";
import { NotesStore, type Note, type NotesRequest } from "./store";
const note:Note={id:"a",title:"first",body:"",pinned:false,deleted:false,createdAt:"now",updatedAt:"now",localRevision:1,pending:false,conflict:false};
afterEach(()=>vi.useRealTimers());
it("serializes typing and retains newer input when an earlier local save completes",async()=>{
  vi.useFakeTimers();let complete!:(n:Note)=>void;const writes:unknown[]=[];
  const request=vi.fn(async(op:string,input?:unknown)=>{if(op==="state")return{unlocked:true,notes:[note],lastSyncedAt:null};if(op==="save"){writes.push(input);if(writes.length===1)return await new Promise<Note>(r=>complete=r);return{...note,title:"latest",localRevision:3,pending:true};}return{unlocked:true,notes:[],lastSyncedAt:null};}) as NotesRequest;
  const store=new NotesStore(request);await store.load();store.edit({...note,title:"older"});store.edit({...note,title:"latest"});
  complete({...note,title:"older",localRevision:2,pending:true});await vi.advanceTimersByTimeAsync(0);
  expect(store.snapshot().notes[0].title).toBe("latest");expect(writes[1]).toMatchObject({expectedRevision:2,title:"latest"});
});
it("failed local save keeps the draft and retries before sending to cloud",async()=>{
  vi.useFakeTimers();let failed=true;
  const request=vi.fn(async(op:string)=>{if(op==="state")return{unlocked:true,notes:[note],lastSyncedAt:null};if(op==="save"){if(failed)throw"disk full";return{...note,title:"draft",localRevision:2,pending:true};}return{unlocked:true,notes:[{...note,title:"draft",localRevision:2}],lastSyncedAt:"now"};}) as NotesRequest;
  const store=new NotesStore(request);await store.load();store.edit({...note,title:"draft"});await vi.advanceTimersByTimeAsync(0);
  expect(store.snapshot().saving).toBe(true);expect(store.snapshot().notes[0].title).toBe("draft");failed=false;await store.sync();expect(store.snapshot().saving).toBe(false);expect(store.snapshot().notes[0].title).toBe("draft");
});
it("a stale sync response never replaces a newer completed local edit",async()=>{
  vi.useFakeTimers();let finish!:(s:unknown)=>void;
  const request=vi.fn(async(op:string)=>{if(op==="state")return{unlocked:true,notes:[note],lastSyncedAt:null};if(op==="sync")return await new Promise(r=>finish=r);return{...note,title:"newer",localRevision:2,pending:true};}) as NotesRequest;
  const store=new NotesStore(request);await store.load();const sync=store.sync();store.edit({...note,title:"newer"});await vi.advanceTimersByTimeAsync(0);
  finish({unlocked:true,notes:[note],lastSyncedAt:"now"});await sync;expect(store.snapshot().notes[0].title).toBe("newer");
});
