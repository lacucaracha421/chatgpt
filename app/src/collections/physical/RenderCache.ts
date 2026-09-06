export type RenderResult = { blob: Blob; width: number; height: number };
export type Snapshot = { url: string; width: number; height: number } | null;
type Listener = (value: Snapshot) => void;
type Producer = (signal: AbortSignal) => Promise<RenderResult>;
type Entry = { value: NonNullable<Snapshot>; bytes: number; users: Set<Listener> };
type Job = { produce: Producer; users: Set<Listener> };
export const THUMBNAIL_LIMIT = { entries:64, bytes:24*1024*1024, pending:96 } as const;
/** Ref-counted LRU: live images are not revoked underneath their readers. */
export class RenderCache {
  private entries = new Map<string, Entry>();
  private jobs = new Map<string, Job>();
  private active: { key:string; job:Job; abort:AbortController; done:Promise<void> } | null = null;
  private timer: ReturnType<typeof setTimeout> | null = null;
  private paused = false;
  bytes = 0; hits = 0; misses = 0; evictions = 0; cancelled = 0; completed = 0;
  constructor(private limits: { entries:number; bytes:number; pending:number } = THUMBNAIL_LIMIT) {}
  acquire(key: string, produce: Producer, listener: Listener): () => void {
    const cached=this.entries.get(key);
    if(cached) {
      this.hits++; cached.users.add(listener); this.entries.delete(key); this.entries.set(key,cached);
      listener(cached.value);
      return () => { cached.users.delete(listener); this.schedule(); };
    }
    let job=this.active?.key===key&&!this.active.abort.signal.aborted?this.active.job:this.jobs.get(key);
    if(!job) {
      if(this.jobs.size>=this.limits.pending) { listener(null); return () => undefined; }
      this.misses++; job={produce,users:new Set()}; this.jobs.set(key,job);
    }
    job.users.add(listener); this.schedule();
    return () => {
      job.users.delete(listener);
      this.entries.get(key)?.users.delete(listener);
      if(!job.users.size) {
        if(this.jobs.get(key)===job) { this.jobs.delete(key); this.cancelled++; }
        if(this.active?.job===job) this.active.abort.abort();
      }
      this.schedule();
    };
  }
  pause(value: boolean) {
    this.paused=value;
    if(value) this.active?.abort.abort(); else this.schedule();
  }
  async whenIdle() { await this.active?.done; }
  private schedule() {
    if(this.timer!==null||this.active||this.paused||!this.jobs.size) return;
    this.timer=setTimeout(() => { this.timer=null; this.pump(); },16);
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
  private pump() {
    if(this.paused||this.active) return;
    const next=this.jobs.entries().next().value; if(!next) return;
    const [key,job]=next; this.jobs.delete(key);
    const abort=new AbortController();
    const done=Promise.resolve().then(async () => {
      try {
        const result=await job.produce(abort.signal);
        if(abort.signal.aborted||!job.users.size) return;
        const bytes=result.width*result.height*4;
        if(!this.makeRoom(bytes)) { for(const user of job.users) user(null); return; }
        const value={url:URL.createObjectURL(result.blob),width:result.width,height:result.height};
        this.entries.set(key,{value,bytes,users:job.users}); this.bytes+=bytes; this.completed++;
        for(const user of job.users) user(value);
      } catch(error) {
        if(!abort.signal.aborted) { for(const user of job.users) user(null); }
      } finally {
        if(abort.signal.aborted&&job.users.size&&this.paused&&!this.jobs.has(key)) this.jobs.set(key,job);
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
  stats() { return { entries:this.entries.size, bytes:this.bytes, pending:this.jobs.size, active:this.active?1:0, hits:this.hits, misses:this.misses, evictions:this.evictions, cancelled:this.cancelled, completed:this.completed }; }
}
