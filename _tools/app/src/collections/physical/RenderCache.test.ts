import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { RenderCache, type RenderResult } from "./RenderCache";
import { makePaperback } from "./paperbackGeometry";
import { coverKey } from "./collectibleRuntime";
import { PAPERBACK_FINAL } from "./PaperbackEngine";
const caches: RenderCache[] = [];
const create = vi.fn(), revoke = vi.fn();
const result = (): RenderResult => ({ blob: new Blob(["pixel"]), width: 4, height: 4 });
beforeEach(() => { vi.useFakeTimers(); let id=0; create.mockImplementation(()=>`blob:fixture-${++id}`); vi.stubGlobal("URL", { createObjectURL:create, revokeObjectURL:revoke }); });
afterEach(() => { for(const cache of caches.splice(0)) cache.clear(); vi.useRealTimers(); vi.unstubAllGlobals(); vi.clearAllMocks(); });
function fresh(entries=64, bytes=24*1024*1024) { const cache=new RenderCache({entries,bytes,pending:96}); caches.push(cache); return cache; }

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
