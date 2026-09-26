import type { SnapshotStore } from "./snapshotStore";
export type RenderResult = { blob: Blob; width: number; height: number };
export type Snapshot = { url: string; width: number; height: number } | null;
type Listener = (value: Snapshot) => void;
/** Read when the next producer is picked: 0 = on screen, 1 = near the viewport. Lower runs first. */
export type Rank = () => number;
type Producer = (signal: AbortSignal) => Promise<RenderResult>;
type Entry = { value: NonNullable<Snapshot>; bytes: number; users: Set<Listener> };
/** `ready` is false while the persistent store is being asked; such a job never occupies the producer. */
type Job = { produce: Producer; users: Map<Listener, Rank>; ready: boolean };
const ON_SCREEN: Rank = () => 0;
// Bytes are the encoded snapshot blobs behind the object URLs (a 256px PNG cover is roughly 0.1–0.2 MB):
// enough for a full large-window screen, its scroll margin and several screens of scroll-back.
export const THUMBNAIL_LIMIT = { entries:256, bytes:64*1024*1024, pending:128 } as const;
/** Ref-counted LRU: live images are not revoked underneath their readers. */
export class RenderCache {
  private entries = new Map<string, Entry>();
  private jobs = new Map<string, Job>();
  private active: { key:string; job:Job; abort:AbortController; done:Promise<void> } | null = null;
  private timer: ReturnType<typeof setTimeout> | null = null;
  private paused = false;
  private unavailable = false;
  bytes = 0; hits = 0; misses = 0; restored = 0; evictions = 0; cancelled = 0; completed = 0;
  constructor(private limits: { entries:number; bytes:number; pending:number } = THUMBNAIL_LIMIT, private store: SnapshotStore | null = null) {}
  acquire(key: string, produce: Producer, listener: Listener, rank: Rank = ON_SCREEN): () => void {
    const cached=this.entries.get(key);
    if(cached) {
      this.hits++; cached.users.add(listener); this.entries.delete(key); this.entries.set(key,cached);
      listener(cached.value);
      return () => { cached.users.delete(listener); this.schedule(); };
    }
    let job=this.active?.key===key&&!this.active.abort.signal.aborted?this.active.job:this.jobs.get(key);
    const created=!job;
    if(!job) {
      if(this.jobs.size>=this.limits.pending) { listener(null); return () => undefined; }
      this.misses++; job={produce,users:new Map(),ready:!this.store}; this.jobs.set(key,job);
    }
    const own=job;
    own.users.set(listener,rank);
    if(created) { if(this.store) this.lookup(key,own); else if(this.unavailable) this.fail(key,own); }
    this.schedule();
    return () => {
      own.users.delete(listener);
      this.entries.get(key)?.users.delete(listener);
      if(!own.users.size) {
        if(this.jobs.get(key)===own) { this.jobs.delete(key); this.cancelled++; }
        if(this.active?.job===own) this.active.abort.abort();
      }
      this.schedule();
    };
  }
  pause(value: boolean) {
    this.paused=value;
    if(value) this.active?.abort.abort(); else this.schedule();
  }
  /** While the renderer is gone (lost GPU context) waiting covers get `null` so they can show their source. */
  setUnavailable(value: boolean) {
    this.unavailable=value;
    if(!value) { this.schedule(); return; }
    for(const [key,job] of this.jobs) if(job.ready) this.fail(key,job);
    this.active?.abort.abort();
  }
  async whenIdle() { await this.active?.done; }
  private fail(key: string, job: Job) {
    if(this.jobs.get(key)===job) this.jobs.delete(key);
    for(const user of [...job.users.keys()]) user(null);
  }
  private lookup(key: string, job: Job) {
    this.store!.get(key).catch(() => null).then(hit => {
      if(this.jobs.get(key)!==job) return;
      if(hit) { this.jobs.delete(key); this.restored++; this.publish(key,job,hit); return; }
      job.ready=true;
      if(this.unavailable) this.fail(key,job); else this.schedule();
    }, () => undefined);
  }
  private schedule() {
    if(this.timer!==null||this.active||this.paused||this.unavailable||!this.jobs.size) return;
    // Yield between producers without making every ready cover wait a frame.
    this.timer=setTimeout(() => { this.timer=null; this.pump(); },0);
  }
  private makeRoom(bytes: number) {
    if(bytes>this.limits.bytes) return false;
    for(const [key,entry] of this.entries) {
      if(this.entries.size<this.limits.entries&&this.bytes+bytes<=this.limits.bytes) break;
      if(entry.users.size) continue;
      URL.revokeObjectURL(entry.value.url); this.bytes-=entry.bytes; this.entries.delete(key); this.evictions++;
    }
    return this.entries.size<this.limits.entries&&this.bytes+bytes<=this.limits.bytes;
  }
  private publish(key: string, job: Job, result: RenderResult) {
    const users=[...job.users.keys()], bytes=result.blob.size;
    if(!this.makeRoom(bytes)) { for(const user of users) user(null); return false; }
    const value={url:URL.createObjectURL(result.blob),width:result.width,height:result.height};
    this.entries.set(key,{value,bytes,users:new Set(users)}); this.bytes+=bytes;
    for(const user of users) user(value);
    return true;
  }
  /** On-screen covers first; equal ranks keep request order. The queue only holds mounted covers, so nothing waits forever. */
  private next() {
    let best:[string,Job]|null=null, bestRank=Infinity;
    for(const [key,job] of this.jobs) {
      if(!job.ready) continue;
      let rank=Infinity; for(const value of job.users.values()) rank=Math.min(rank,value());
      if(rank<bestRank) { best=[key,job]; bestRank=rank; if(rank<=0) break; }
    }
    return best;
  }
  private pump() {
    if(this.paused||this.active||this.unavailable) return;
    const next=this.next(); if(!next) return;
    const [key,job]=next; this.jobs.delete(key);
    const abort=new AbortController();
    const done=Promise.resolve().then(async () => {
      try {
        const result=await job.produce(abort.signal);
        if(abort.signal.aborted) return;
        this.store?.put(key,result);
        if(!job.users.size) return;
        if(this.publish(key,job,result)) this.completed++;
      } catch(error) {
        if(!abort.signal.aborted) { for(const user of job.users.keys()) user(null); }
      } finally {
        if(abort.signal.aborted&&job.users.size) {
          if(this.unavailable) this.fail(key,job);
          else if(this.paused&&!this.jobs.has(key)) this.jobs.set(key,job);
        }
        this.active=null; this.schedule();
      }
    });
    this.active={key,job,abort,done};
  }
  clear() {
    if(this.timer!==null) clearTimeout(this.timer); this.timer=null;
    this.active?.job.users.clear(); this.active?.abort.abort(); this.jobs.clear();
    for(const entry of this.entries.values()) { for(const user of entry.users) user(null); URL.revokeObjectURL(entry.value.url); }
    this.entries.clear(); this.bytes=0;
  }
  stats() { return { entries:this.entries.size, bytes:this.bytes, pending:this.jobs.size, active:this.active?1:0, hits:this.hits, restored:this.restored, misses:this.misses, evictions:this.evictions, cancelled:this.cancelled, completed:this.completed }; }
}
