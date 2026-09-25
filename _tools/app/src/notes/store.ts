import { invoke } from "@tauri-apps/api/core";
import type { ChecklistItem, NoteKind, SecretField } from "./model";

/** A decrypted note as the PC backend returns it (Notes v2 fields are optional: v1 notes lack them). */
export type Note = {id:string; title:string; body:string; pinned:boolean; deleted:boolean; createdAt:string; updatedAt:string; localRevision:number; pending:boolean; conflict:boolean;
  schema?:number; type?:string; color?:string|null; labels?:string[]; archived?:boolean; items?:ChecklistItem[]; fields?:SecretField[]; memo?:string;
  /** Local copy kept when an edit collision could not merge. */ conflictCopy?:boolean;
  /** Newer schema or unknown type: only pin/trash/archive/restore. */ readOnly?:boolean;
  /** Secret note while the PIN session is closed: only the title is present. */ redacted?:boolean;
  /** Save response only: a stale draft that could not merge was kept as this new note. */ copiedTo?:string};
export type NotesState = {unlocked:boolean; keyringLocked?:boolean; unreadable?:number; notes:Note[]; lastSyncedAt:string|null};
/** Backend texts the UI answers with a PIN prompt instead of an error (see notes.rs). */
export const SECRET_LOCKED_TEXT="암호 메모 잠금을 해제해 주세요.";
export const PIN_REQUIRED_TEXT="복구키를 보려면 암호 메모 PIN을 먼저 입력해 주세요.";
/** Fields a draft carries; used to rebase a newer queued draft onto a merged save. */
const DRAFT_KEYS=["title","body","pinned","deleted","archived","type","color","labels","items","fields","memo"] as const;
const same=(a:unknown,b:unknown)=>JSON.stringify(a)===JSON.stringify(b);
const redact=(n:Note):Note=>({...n,body:"",memo:undefined,fields:undefined,labels:undefined,redacted:true});
export type SecretStatus = {pinSet:boolean; unlocked:boolean};
export const noteKind=(note:Pick<Note,"type">)=>note.type??"text";
export const isSecret=(note:Pick<Note,"type">)=>note.type==="secret";

/** Sends only what this client edits; the backend keeps every other stored field. */
function draftOf(note:Note,expectedRevision:number){
  const base={id:note.id,expectedRevision,pinned:note.pinned,deleted:note.deleted,archived:!!note.archived};
  if(note.readOnly)return base;
  if(note.redacted)return {...base,title:note.title,color:note.color??null};
  const kind=noteKind(note);
  const content=kind==="checklist"?{items:note.items??[]}:kind==="secret"?{fields:note.fields??[],memo:note.memo??""}:{body:note.body};
  return {...base,type:kind,title:note.title,color:note.color??null,labels:note.labels??[],...content};
}
export type Snapshot = NotesState & {ready:boolean; saving:boolean; syncing:boolean; error:string|null;
  /** A secret-note save waits for the PIN; the draft stays queued. */ secretLocked?:boolean;
  /** A stale draft moved to a keep-both copy; the editor follows it. */ moved?:{from:string;to:string}|null};
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
  async load(){if(this.current.ready&&!this.current.error&&!this.current.keyringLocked)return;try{this.merge(await this.request<NotesState>("state"));this.patch({error:null});}catch(e){this.patch({error:message(e),ready:true});}}
  async unlock(key:string){try{this.merge(await this.request<NotesState>("unlock",{key}));this.patch({error:null});return true;}catch(e){this.patch({error:message(e)});return false;}}
  edit(note:Note){
    this.lastEdit=Date.now();clearTimeout(this.timer);
    // A metadata change made from a redacted view never replaces a queued revealed draft.
    const queued=this.queue.get(note.id);
    if(note.redacted&&queued&&!queued.redacted)note={...queued,title:note.title,pinned:note.pinned,deleted:note.deleted,archived:note.archived,color:note.color};
    const updated={...note,updatedAt:new Date().toISOString(),pending:true};this.queue.set(note.id,updated);
    this.patch({notes:[updated,...this.current.notes.filter(n=>n.id!==note.id)],saving:true,error:null});void this.drain();
  }
  create(kind:NoteKind="text"){
    const now=new Date().toISOString();
    const note:Note={id:crypto.randomUUID(),title:"",body:"",pinned:false,deleted:false,createdAt:now,updatedAt:now,localRevision:0,pending:true,conflict:false,
      ...(kind==="checklist"?{type:kind,items:[]}:kind==="secret"?{type:kind,fields:[],memo:""}:{})};
    this.edit(note);return note.id;
  }
  /** Only after the user opened Notes: may show the system keyring password dialog. */
  async unlockKeyring(){try{this.merge(await this.request<NotesState>("unlockKeyring"));this.patch({error:null});}catch(e){this.patch({error:message(e)});}}
  async refresh(){try{this.merge(await this.request<NotesState>("state"));this.patch({error:null});}catch(e){this.patch({error:message(e)});}}
  secretStatus(){return this.request<SecretStatus>("secretStatus");}
  /** secretSetPin / secretUnlock / secretResetPin; returns an error message for inline display. */
  async openSecrets(operation:"secretSetPin"|"secretUnlock"|"secretResetPin",input:Record<string,string>){
    try{this.merge(await this.request<NotesState>(operation,input));}catch(e){return typeof e==="string"?e:"암호 메모를 열지 못했습니다.";}
    this.resumeSecretSaves();
    return null;
  }
  /** After a PIN unlock, retries secret-note drafts that were waiting for it. */
  resumeSecretSaves(){if(this.current.secretLocked){this.patch({secretLocked:false});void this.drain();}}
  clearMoved(){if(this.current.moved)this.patch({moved:null});}
  /** Keeps the backend PIN session alive while the user works; locks locally if it expired. */
  async touchSecrets(){
    try{const {unlocked}=await this.request<{unlocked:boolean}>("secretTouch");if(!unlocked)this.redactSecrets();}catch{/* next save or sync reports it */}
  }
  private redactSecrets(){
    const busy=new Set([...this.queue.keys(),...(this.writing?[this.writing]:[])]);
    if(this.current.notes.some(n=>isSecret(n)&&!n.redacted&&!busy.has(n.id)))
      this.patch({notes:this.current.notes.map(n=>isSecret(n)&&!n.redacted&&!busy.has(n.id)?redact(n):n)});
  }
  /** Closes the PIN session and drops revealed secret content from memory. */
  async lockSecrets(){
    // Save first; a draft that could not be saved stays visible rather than being dropped.
    await this.flush();
    try{await this.request("secretLock");}catch{/* the backend session also expires on its own */}
    this.redactSecrets();
  }
  async dismissConflictCopy(id:string){
    try{await this.request("dismissConflictCopy",{id});this.patch({notes:this.current.notes.map(n=>n.id===id?{...n,conflictCopy:false}:n)});}
    catch(e){this.patch({error:message(e)});}
  }
  private drain():Promise<void>{
    if(this.running)return this.running;
    this.running=(async()=>{
      while(this.queue.size){
        const [id,draft]=this.queue.entries().next().value!;this.queue.delete(id);this.writing=id;
        const expectedRevision=this.current.notes.find(n=>n.id===id)?.localRevision??0;
        try{
          const saved=await this.request<Note>("save",draftOf(draft,expectedRevision));
          const newer=this.queue.get(id);
          if(saved.copiedTo){
            // The stale draft could not merge and was kept as a separate note: keep typing there.
            const copyId=saved.copiedTo;const copy:Note={...(newer??draft),id:copyId,localRevision:1,pending:true,conflict:false,conflictCopy:true};
            if(newer){this.queue.delete(id);this.queue.set(copyId,copy);}
            this.patch({notes:[copy,...this.current.notes.map(n=>n.id===id?{...saved,copiedTo:undefined}:n)],moved:{from:id,to:copyId}});
          }else if(newer){
            // Rebase the newer draft: fields it did not change since this save take the saved (possibly merged) values.
            const rebased:Note={...newer,localRevision:saved.localRevision,conflict:saved.conflict};
            for(const key of DRAFT_KEYS)if(same(newer[key],draft[key])&&!same(saved[key],draft[key]))(rebased as Record<string,unknown>)[key]=saved[key];
            this.queue.set(id,rebased);
            this.patch({notes:this.current.notes.map(n=>n.id===id?rebased:n)});
          }else this.patch({notes:this.current.notes.map(n=>n.id===id?saved:n)});
        }catch(e){
          this.queue.set(id,this.queue.get(id)??draft);
          // A secret save needs the PIN: keep the draft and ask, instead of showing an error.
          if(e===SECRET_LOCKED_TEXT)this.patch({secretLocked:true});else this.patch({error:message(e)});
          break;
        }
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
export async function lockAllSecrets(){await Promise.all([...stores.values()].filter(store=>store.snapshot().unlocked).map(store=>store.lockSecrets()));}
export async function flushNotes(){return (await Promise.all([...stores.values()].map(store=>store.flush()))).every(Boolean);}
