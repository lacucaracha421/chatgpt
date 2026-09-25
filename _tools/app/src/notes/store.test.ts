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
it("batches automatic syncs while preserving immediate local saves and manual sync",async()=>{
  vi.useFakeTimers();let saved=note;
  const request=vi.fn(async(op:string,input:any)=>{if(op==="save"){saved={...saved,...input,localRevision:saved.localRevision+1,pending:true};return saved;}if(op==="sync")saved={...saved,pending:false};return{unlocked:true,notes:[saved],lastSyncedAt:null};}) as NotesRequest;
  const store=new NotesStore(request);await store.load();
  store.edit({...note,title:"one"});await vi.advanceTimersByTimeAsync(5000);
  expect(vi.mocked(request).mock.calls.filter(c=>c[0]==="save")).toHaveLength(1);
  expect(vi.mocked(request).mock.calls.filter(c=>c[0]==="sync")).toHaveLength(0);
  store.edit({...saved,title:"two"});await vi.advanceTimersByTimeAsync(9999);
  expect(vi.mocked(request).mock.calls.filter(c=>c[0]==="sync")).toHaveLength(0);
  await vi.advanceTimersByTimeAsync(1);
  expect(vi.mocked(request).mock.calls.filter(c=>c[0]==="sync")).toHaveLength(1);
  await store.sync(false);await store.sync(false);
  expect(vi.mocked(request).mock.calls.filter(c=>c[0]==="sync")).toHaveLength(1);
  store.edit({...saved,title:"three"});await vi.advanceTimersByTimeAsync(59000);
  expect(vi.mocked(request).mock.calls.filter(c=>c[0]==="sync")).toHaveLength(1);
  await vi.advanceTimersByTimeAsync(1000);
  expect(vi.mocked(request).mock.calls.filter(c=>c[0]==="sync")).toHaveLength(2);
  await store.sync();expect(vi.mocked(request).mock.calls.filter(c=>c[0]==="sync")).toHaveLength(3);
});
it("coalesces sync requests that arrive while waiting for a local save",async()=>{
  vi.useFakeTimers();let finish!:(n:Note)=>void;
  const request=vi.fn(async(op:string)=>{if(op==="save")return new Promise<Note>(r=>finish=r);return{unlocked:true,notes:[note],lastSyncedAt:null};}) as NotesRequest;
  const store=new NotesStore(request);await store.load();store.edit({...note,title:"draft"});
  const first=store.sync(),second=store.sync();finish({...note,title:"draft",localRevision:2});await Promise.all([first,second]);
  expect(vi.mocked(request).mock.calls.filter(c=>c[0]==="sync")).toHaveLength(1);
});
it("creates a pinned ledger and hidden month notes and sends only ledger fields",async()=>{
  vi.useFakeTimers();const saves:any[]=[];const monthId="f33fe4b5-0eab-fb00-e7f3-c72ba551e99f";
  const request=vi.fn(async(op:string,input:any)=>{if(op==="ledgerMonthId")return{id:monthId};if(op==="save"){saves.push(input);return{...note,...input,localRevision:1,pending:true};}return{unlocked:true,notes:[],lastSyncedAt:null};}) as NotesRequest;
  const store=new NotesStore(request);await store.load();
  const ledgerId=store.create("ledger");await vi.advanceTimersByTimeAsync(0);
  expect(saves[0]).toEqual({id:ledgerId,expectedRevision:0,pinned:true,deleted:false,archived:false,type:"ledger",title:"가계부",color:null,labels:[],income:null,recurring:[],planned:[]});
  expect(await store.ledgerMonth(ledgerId,"2026-09")).toBe(monthId);await vi.advanceTimersByTimeAsync(0);
  expect(request).toHaveBeenCalledWith("ledgerMonthId",{ledger:ledgerId,month:"2026-09"});
  expect(saves[1]).toMatchObject({id:monthId,type:"ledger-month",title:"가계부 2026년 9월",ledger:ledgerId,month:"2026-09",income:null,entries:[],archived:true});
  expect(saves[1]).not.toHaveProperty("body");
  // An existing month note is reused, not recreated.
  expect(await store.ledgerMonth(ledgerId,"2026-09")).toBe(monthId);await vi.advanceTimersByTimeAsync(0);
  expect(saves).toHaveLength(2);
});
it("rebases a queued ledger draft per entry, keeping an entry a merged save brought in",async()=>{
  vi.useFakeTimers();let finish!:(n:Note)=>void;const saves:any[]=[];
  const e=(id:string)=>({id,date:"2026-09-25",amount:1000,name:id,createdAt:`c-${id}`});
  const month:Note={...note,id:"m",type:"ledger-month",ledger:"L",month:"2026-09",income:null,entries:[e("a")]};
  const request=vi.fn(async(op:string,input:any)=>{if(op==="state")return{unlocked:true,notes:[month],lastSyncedAt:null};if(op==="save"){saves.push(input);
    // The first save lands on a note a pull changed: the backend merges in the remote entry R.
    if(saves.length===1)return await new Promise<Note>(r=>finish=r);return{...month,...input,localRevision:3,pending:true};}return{unlocked:true,notes:[],lastSyncedAt:null};}) as NotesRequest;
  const store=new NotesStore(request);await store.load();
  store.edit({...month,entries:[e("a"),e("b")]});
  store.edit({...month,entries:[e("a"),e("b"),e("c")].map(x=>x.id==="a"?{...x,amount:2000}:x)});
  finish({...month,entries:[e("a"),e("b"),e("R")],localRevision:2,pending:true});await vi.advanceTimersByTimeAsync(0);
  expect(saves[1].entries.map((x:any)=>[x.id,x.amount])).toEqual([["a",2000],["b",1000],["R",1000],["c",1000]]);
});
