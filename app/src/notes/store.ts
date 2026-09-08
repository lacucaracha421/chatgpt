import { invoke } from "@tauri-apps/api/core";

export type Note = {id:string; title:string; body:string; pinned:boolean; deleted:boolean; createdAt:string; updatedAt:string; localRevision:number; pending:boolean; conflict:boolean};
export type NotesState = {unlocked:boolean; notes:Note[]; lastSyncedAt:string|null};
export type Snapshot = NotesState & {ready:boolean; saving:boolean; syncing:boolean; error:string|null};
export type NotesRequest = <T>(operation:string,input?:unknown)=>Promise<T>;
export const NOTES_REFRESH_INTERVAL = 5 * 60_000;
const AUTO_SYNC_IDLE = 10_000;
const AUTO_SYNC_MIN_INTERVAL = 60_000;
const message=(error:unknown)=>typeof error === "string" ? error : "메모 작업을 완료하지 못했습니다. 작성 내용은 유지됩니다.";

/** Lives beyond area navigation; immediate serialized local writes never depend on a debounce. */
export class NotesStore {
  private current:Snapshot={ready:false,unlocked:false,notes:[],lastSyncedAt:null,saving:false,syncing:false,error:null};
  private listeners=new Set<()=>void>();
  private queue=new Map<string,Note>();
  private running:Promise<void>|null=null;
  private writing:string|null=null;
  private timer:ReturnType<typeof setTimeout>|undefined;
  private lastSyncAttempt = -Infinity;
  private lastEdit = -Infinity;
  constructor(readonly request:NotesRequest) {}
  snapshot=()=>this.current;
  subscribe=(fn:()=>void)=>{this.listeners.add(fn);return()=>{this.listeners.delete(fn);};};
  private patch(change:Partial<Snapshot>){this.current={...this.current,...change};for(const fn of this.listeners)fn();}
  private merge(state:NotesState){
    const protectedIds=new Set([...this.queue.keys(),...(this.writing?[this.writing]:[])]);
    const merged=new Map(state.notes.map(n=>[n.id,n]));
    for(const current of this.current.notes){const incoming=merged.get(current.id);if(protectedIds.has(current.id)||!incoming||current.localRevision>incoming.localRevision)merged.set(current.id,current);}
    this.patch({...state,notes:[...merged.values()],ready:true});
  }
  async load(){if(this.current.ready&&!this.current.error)return;try{this.merge(await this.request<NotesState>("state"));this.patch({error:null});}catch(e){this.patch({error:message(e),ready:true});}}
  async unlock(key:string){try{this.merge(await this.request<NotesState>("unlock",{key}));this.patch({error:null});return true;}catch(e){this.patch({error:message(e)});return false;}}
  edit(note:Note){
    this.lastEdit=Date.now();clearTimeout(this.timer);
    const updated={...note,updatedAt:new Date().toISOString(),pending:true};this.queue.set(note.id,updated);
    this.patch({notes:[updated,...this.current.notes.filter(n=>n.id!==note.id)],saving:true,error:null});void this.drain();
  }
  create(){const now=new Date().toISOString();const note:Note={id:crypto.randomUUID(),title:"",body:"",pinned:false,deleted:false,createdAt:now,updatedAt:now,localRevision:0,pending:true,conflict:false};this.edit(note);return note.id;}
  private drain():Promise<void>{
    if(this.running)return this.running;
    this.running=(async()=>{
      while(this.queue.size){
        const [id,draft]=this.queue.entries().next().value!;this.queue.delete(id);this.writing=id;
        const expectedRevision=this.current.notes.find(n=>n.id===id)?.localRevision??0;
        try{
          const saved=await this.request<Note>("save",{id,title:draft.title,body:draft.body,pinned:draft.pinned,deleted:draft.deleted,expectedRevision});
          this.patch({notes:this.current.notes.map(n=>n.id===id?(this.queue.has(id)?{...n,localRevision:saved.localRevision,conflict:saved.conflict}:saved):n)});
        }catch(e){this.queue.set(id,this.queue.get(id)??draft);this.patch({error:message(e)});break;}
        finally{this.writing=null;}
      }
    })().finally(()=>{this.running=null;this.patch({saving:this.queue.size>0});if(!this.queue.size)this.scheduleSync();});
    return this.running;
  }
  private scheduleSync(){
    clearTimeout(this.timer);
    const delay=Math.max(AUTO_SYNC_IDLE, this.lastEdit+AUTO_SYNC_IDLE-Date.now(), this.lastSyncAttempt+AUTO_SYNC_MIN_INTERVAL-Date.now());
    this.timer=setTimeout(()=>void this.sync(false),delay);
  }
  async sync(manual=true){
    if(this.current.syncing || !this.current.unlocked)return;
    if(!manual && (Date.now()-this.lastSyncAttempt<AUTO_SYNC_MIN_INTERVAL || Date.now()-this.lastEdit<AUTO_SYNC_IDLE))return;
    clearTimeout(this.timer);
    // Claim the sync before awaiting local saves so focus/manual/timer requests cannot overlap.
    this.patch({syncing:true});
    this.lastSyncAttempt=Date.now();
    try{
      if(this.queue.size || this.running){await this.drain();clearTimeout(this.timer);if(this.queue.size)return;}
      this.merge(await this.request<NotesState>("sync"));this.patch({error:null});
    }catch(e){this.patch({error:message(e)});}
    finally{
      this.patch({syncing:false});
      if(!this.queue.size && this.current.notes.some(note=>note.pending&&!note.conflict))this.scheduleSync();
    }
  }
  async resolve(note:Note,keepCopy:boolean){
    if(this.current.syncing)return;
    if(this.queue.size || this.running)await this.drain();
    if(this.queue.size)return;
    try{this.merge(await this.request<NotesState>("resolve",{id:note.id,expectedRevision:this.current.notes.find(n=>n.id===note.id)?.localRevision,keepCopy}));this.patch({error:null});}
    catch(e){this.patch({error:message(e)});}
  }
  async flush(){if(this.queue.size||this.running)await this.drain();return !this.queue.size;}
  async backup(operation:"export"|"import"){
    if(!await this.flush())return;
    try{const result=await this.request<NotesState|null|boolean>(operation);if(result&&typeof result==="object")this.merge(result);this.patch({error:null});}
    catch(e){this.patch({error:message(e)});}
  }
}
const stores=new Map<string,NotesStore>();
export function notesStore(root:string){let store=stores.get(root);if(!store){store=new NotesStore((operation,input={})=>invoke("notes_request",{root,operation,input}));stores.set(root,store);}return store;}
export function hasUnsavedNotes(){return [...stores.values()].some(store=>store.snapshot().saving);}
export async function flushNotes(){return (await Promise.all([...stores.values()].map(store=>store.flush()))).every(Boolean);}
