import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { RenderCache, THUMBNAIL_LIMIT, type RenderResult } from "./RenderCache";
import { planEviction, type SnapshotStore } from "./snapshotStore";
import { makePaperback } from "./paperbackGeometry";
import { coverKey } from "./collectibleRuntime";
import { PAPERBACK_FINAL } from "./PaperbackEngine";
const caches: RenderCache[] = [];
const create = vi.fn(), revoke = vi.fn();
const result = (bytes = 64): RenderResult => ({ blob: new Blob([new Uint8Array(bytes)], { type: "image/png" }), width: 4, height: 4 });
beforeEach(() => { vi.useFakeTimers(); let id=0; create.mockImplementation(()=>`blob:fixture-${++id}`); vi.stubGlobal("URL", { createObjectURL:create, revokeObjectURL:revoke }); });
afterEach(() => { for(const cache of caches.splice(0)) cache.clear(); vi.useRealTimers(); vi.unstubAllGlobals(); vi.clearAllMocks(); });
function fresh(entries=64, bytes=24*1024*1024, store: SnapshotStore | null = null) { const cache=new RenderCache({entries,bytes,pending:96},store); caches.push(cache); return cache; }
/** Stands in for IndexedDB: it survives a new RenderCache like the webview's storage survives a restart. */
function memoryStore() {
  const saved=new Map<string,RenderResult>();
  const store={ saved, get:vi.fn(async (key:string)=>saved.get(key)??null), put:vi.fn((key:string,value:RenderResult)=>{ saved.set(key,value); }) };
  return store;
}

describe("bounded collectible cache", () => {
  it("does not charge a frame delay for every ready cover", async () => {
    const cache=fresh(),notify=vi.fn();
    for(let i=0;i<16;i++) cache.acquire(String(i),async()=>result(),notify);
    await vi.advanceTimersByTimeAsync(32);
    expect(notify).toHaveBeenCalledTimes(16);
  });
  it("deduplicates one raster and keeps it alive until readers release it", async () => {
    const cache=fresh(1,64),produce=vi.fn(async()=>result()),a=vi.fn(),b=vi.fn();
    const releaseA=cache.acquire("a",produce,a); const releaseB=cache.acquire("a",produce,b);
    await vi.runAllTimersAsync();
    expect(produce).toHaveBeenCalledOnce(); expect(a.mock.calls[0][0].url).toBe(b.mock.calls[0][0].url);
    releaseA(); expect(revoke).not.toHaveBeenCalled();
    releaseB(); cache.acquire("b",produce,vi.fn()); await vi.runAllTimersAsync();
    expect(revoke).toHaveBeenCalledWith("blob:fixture-1"); expect(cache.stats().entries).toBe(1); expect(cache.stats().bytes).toBe(64);
  });
  it("cancels the last waiter and never publishes obsolete results", async () => {
    const cache=fresh(),notify=vi.fn(); let finish!:(value:RenderResult)=>void; let signal!:AbortSignal;
    const stop=cache.acquire("late",input=>{signal=input;return new Promise(resolve=>{finish=resolve;});},notify);
    await vi.advanceTimersByTimeAsync(20); stop(); expect(signal.aborted).toBe(true);
    finish(result()); await cache.whenIdle(); expect(notify).not.toHaveBeenCalled(); expect(create).not.toHaveBeenCalled();
  });
  it("never exceeds the decoded budget or revokes a pinned raster", async () => {
    const cache=fresh(2,128),releaseA=cache.acquire("a",async()=>result(),vi.fn());
    cache.acquire("b",async()=>result(),vi.fn()); await vi.runAllTimersAsync();
    const overflow=vi.fn(); cache.acquire("c",async()=>result(),overflow); await vi.runAllTimersAsync();
    expect(overflow).toHaveBeenCalledWith(null); expect(cache.stats().bytes).toBe(128); expect(revoke).not.toHaveBeenCalled();
    releaseA(); cache.acquire("c",async()=>result(),vi.fn()); await vi.runAllTimersAsync();
    expect(cache.stats().entries).toBe(2); expect(cache.stats().bytes).toBe(128); expect(revoke).toHaveBeenCalledOnce();
  });
  it("runs only one producer at a time and pauses background work for the live book", async () => {
    const cache=fresh(); let finish!:(value:RenderResult)=>void;
    const first=vi.fn(()=>new Promise<RenderResult>(resolve=>{finish=resolve;})); const second=vi.fn(async()=>result());
    cache.acquire("a",first,vi.fn()); cache.acquire("b",second,vi.fn()); await vi.advanceTimersByTimeAsync(20);
    expect(second).not.toHaveBeenCalled(); expect(cache.stats().active).toBe(1);
    cache.pause(true); finish(result()); await cache.whenIdle(); await vi.advanceTimersByTimeAsync(100);
    expect(second).not.toHaveBeenCalled(); cache.pause(false); await vi.advanceTimersByTimeAsync(20);
    expect(second).toHaveBeenCalledOnce();
  });
  it("reuses an unmounted entry without recomputing it", async () => {
    const cache=fresh(),produce=vi.fn(async()=>result()); const stop=cache.acquire("same",produce,vi.fn()); await vi.runAllTimersAsync(); stop();
    const next=vi.fn(); cache.acquire("same",produce,next); expect(next).toHaveBeenCalledOnce(); expect(produce).toHaveBeenCalledOnce(); expect(cache.stats().hits).toBe(1);
  });
});
it("retains the FINAL thin closed mesh with finite normals and bounded geometry", () => {
  const mesh=makePaperback(); expect(mesh.triangles).toBe(7888); expect(mesh.vertices.length/9).toBeLessThan(6000);
  expect([...mesh.vertices].every(Number.isFinite)).toBe(true); expect(Math.max(...mesh.indices)).toBeLessThan(mesh.vertices.length/9);
  expect(PAPERBACK_FINAL.depth).toBe(.12); expect(PAPERBACK_FINAL.ry).toBe(.34);
});
it("keys include library, source revision, renderer and resolution", () => {
  const a={kind:"book" as const,scope:"library-a",src:"cover",revision:"one",pixels:256};
  for(const change of [{scope:"library-b"},{revision:"two"},{pixels:320},{kind:"game" as const}]) expect(coverKey(a)).not.toBe(coverKey({...a,...change}));
});

describe("persistent snapshots", () => {
  it("serves a key rendered in an earlier session without calling the producer", async () => {
    const store=memoryStore();
    const first=fresh(64,24*1024*1024,store),produce=vi.fn(async()=>result());
    first.acquire("cover",produce,vi.fn()); await vi.runAllTimersAsync();
    expect(produce).toHaveBeenCalledOnce(); expect(store.put).toHaveBeenCalledWith("cover",expect.objectContaining({width:4,height:4}));
    first.clear();
    const second=fresh(64,24*1024*1024,store),again=vi.fn(async()=>result()),notify=vi.fn();
    second.acquire("cover",again,notify); await vi.runAllTimersAsync();
    expect(again).not.toHaveBeenCalled(); expect(notify).toHaveBeenCalledWith(expect.objectContaining({url:expect.stringMatching(/^blob:/)}));
    expect(second.stats()).toMatchObject({restored:1,completed:0,entries:1});
  });
  it("renders on a store miss or a failing store", async () => {
    const store=memoryStore(); store.get.mockRejectedValueOnce(new Error("quota"));
    const cache=fresh(64,24*1024*1024,store),produce=vi.fn(async()=>result()),a=vi.fn(),b=vi.fn();
    cache.acquire("broken",produce,a); cache.acquire("missing",produce,b); await vi.runAllTimersAsync();
    expect(produce).toHaveBeenCalledTimes(2); expect(a.mock.calls[0][0]).not.toBeNull(); expect(b.mock.calls[0][0]).not.toBeNull();
  });
  it("drops a lookup whose cover left before the store answered", async () => {
    const store=memoryStore(); store.saved.set("gone",result());
    const cache=fresh(64,24*1024*1024,store),notify=vi.fn();
    cache.acquire("gone",async()=>result(),notify)(); await vi.runAllTimersAsync();
    expect(notify).not.toHaveBeenCalled(); expect(cache.stats().entries).toBe(0);
  });
  it("keeps the most recently used snapshots within the byte budget", () => {
    const metas=[{key:"old",bytes:40,used:1},{key:"new",bytes:40,used:3},{key:"mid",bytes:40,used:2}];
    expect(planEviction(metas,100)).toEqual(["old"]); expect(planEviction(metas,120)).toEqual([]); expect(planEviction(metas,30)).toEqual(["new","mid","old"]);
  });
});
describe("render order and availability", () => {
  it("renders on-screen covers before nearby ones and still finishes the nearby ones", async () => {
    const cache=fresh(),order:string[]=[],rank={near:1};
    const produce=(key:string)=>async()=>{ order.push(key); return result(); };
    cache.acquire("near-1",produce("near-1"),vi.fn(),()=>1);
    cache.acquire("near-2",produce("near-2"),vi.fn(),()=>rank.near);
    cache.acquire("visible",produce("visible"),vi.fn(),()=>0);
    await vi.advanceTimersByTimeAsync(0); expect(order).toEqual(["visible"]);
    rank.near=0; // scrolled into view while waiting: equal ranks keep request order
    cache.acquire("visible-2",produce("visible-2"),vi.fn(),()=>0);
    await vi.runAllTimersAsync();
    expect(order).toEqual(["visible","near-2","visible-2","near-1"]);
  });
  it("fails waiting covers while the renderer is unavailable, but still serves stored ones", async () => {
    const store=memoryStore(); store.saved.set("stored",result());
    const cache=fresh(64,24*1024*1024,store),active=vi.fn(),queued=vi.fn();
    const hang=(signal:AbortSignal)=>new Promise<RenderResult>((_,reject)=>signal.addEventListener("abort",()=>reject(new DOMException("Cancelled","AbortError"))));
    cache.acquire("active",hang,active); cache.acquire("queued",hang,queued); await vi.advanceTimersByTimeAsync(0);
    expect(cache.stats().active).toBe(1);
    cache.pause(true); cache.setUnavailable(true); await vi.runAllTimersAsync();
    expect(active).toHaveBeenCalledExactlyOnceWith(null); expect(queued).toHaveBeenCalledExactlyOnceWith(null); expect(cache.stats().pending).toBe(0);
    const later=vi.fn(),stored=vi.fn(),produce=vi.fn(async()=>result());
    cache.acquire("later",produce,later); cache.acquire("stored",produce,stored); await vi.runAllTimersAsync();
    expect(later).toHaveBeenCalledWith(null); expect(stored).toHaveBeenCalledWith(expect.objectContaining({width:4})); expect(produce).not.toHaveBeenCalled();
  });
});
// Deterministic harness for the Collections list: scroll down N screens, then back up (renders = producer calls).
async function scrollBackRenders(cache: RenderCache, screens: number, perScreen: number, blobBytes: number) {
  let renders=0;
  const visit=async(screen:number)=>{
    const releases=Array.from({length:perScreen},(_,index)=>cache.acquire(`cover-${screen}-${index}`,async()=>{ renders++; return result(blobBytes); },vi.fn()));
    await vi.runAllTimersAsync(); for(const release of releases) release();
  };
  for(let screen=0;screen<screens;screen++) await visit(screen);
  const firstPass=renders;
  for(let screen=screens-1;screen>=0;screen--) await visit(screen);
  return { firstPass, scrollBack:renders-firstPass };
}
describe("scroll-back harness", () => {
  // 6 screens × 36 covers of ~150 KB PNG; the previous limits were 64 entries / 24 MB of decoded pixels.
  it("re-renders nothing when scrolling back through six screens, and nothing on the next app start", async () => {
    const before=await scrollBackRenders(fresh(64,Number.MAX_SAFE_INTEGER),6,36,150_000);
    expect(before.scrollBack).toBeGreaterThanOrEqual(150);
    const store=memoryStore();
    const after=await scrollBackRenders(fresh(THUMBNAIL_LIMIT.entries,THUMBNAIL_LIMIT.bytes,store),6,36,150_000);
    expect(after).toEqual({firstPass:216,scrollBack:0});
    const nextSession=await scrollBackRenders(fresh(THUMBNAIL_LIMIT.entries,THUMBNAIL_LIMIT.bytes,store),6,36,150_000);
    expect(nextSession).toEqual({firstPass:0,scrollBack:0});
  });
  it("never holds more than the memory budget", async () => {
    const cache=fresh(256,1_000_000);
    await scrollBackRenders(cache,4,36,150_000);
    expect(cache.stats().bytes).toBeLessThanOrEqual(1_000_000); expect(cache.stats().entries).toBeLessThanOrEqual(6);
  });
});
