/** Connection-scoped durable pin intents. Reads never enqueue; only user actions do. */
import type {MangaIndexIdentity} from '../src/library/types';
import type {BookmarkAuthority} from './bookmarkOutbox';
import {connectionOutbox,outboxConnection,outboxKey} from './outboxConnection';
import {api,ApiError} from './transport';
import {mangaIndexKey} from '../src/manga/mangaIndexModel';

export const INDEX_PATH='/v1/mobile-catalog/index';
export type PinState=MangaIndexIdentity&{desiredState:boolean;entityRevision:number;createdAt:string|null;updatedAt:string|null};
export type PinSnapshot={libraryId:string;epoch:number;contractVersion:number;revision:number;items:PinState[]};
type Intent={identity:MangaIndexIdentity;desired:boolean;operationId:string;epoch:number;baseRevision:number;createdAt:string};
type Store={snapshot:PinSnapshot|null;intents:Record<string,Intent>};
const STORE=connectionOutbox('lakomics.catalog.index.pins.v1');
function storageKey(authority:BookmarkAuthority,connection=outboxConnection()){
  const bucket=outboxKey(STORE,connection);return bucket?`${bucket}.${authority.libraryId}`:null;
}
function read(authority:BookmarkAuthority,connection=outboxConnection()):Store{
  try{const key=storageKey(authority,connection),raw=key?localStorage.getItem(key):null;return raw?JSON.parse(raw) as Store:{snapshot:null,intents:{}};}
  catch{return {snapshot:null,intents:{}};}
}
function write(authority:BookmarkAuthority,value:Store,connection=outboxConnection()){
  const key=storageKey(authority,connection);
  if(!key)throw new Error('서버 연결을 확인해 주세요.');
  // Refuse the visible change if storage refuses it, rather than losing offline intent.
  try{localStorage.setItem(key,JSON.stringify(value));}catch{throw new Error('고정을 저장하지 못했습니다. 저장 공간을 확인해 주세요.');}
}
function validState(row:PinState){
  return row&&['tag','artist'].includes(row.kind)&&/^[a-z]{1,32}$/.test(row.namespace)
    &&(row.kind==='artist')===(row.namespace==='artist')&&typeof row.value==='string'&&!!row.value.trim()
    &&typeof row.label==='string'&&!!row.label.trim()&&typeof row.desiredState==='boolean'
    &&Number.isSafeInteger(row.entityRevision)&&row.entityRevision>=0;
}
export function validatePinSnapshot(snapshot:PinSnapshot,authority:BookmarkAuthority){
  if(!snapshot||snapshot.libraryId!==authority.libraryId||snapshot.epoch!==authority.epoch||snapshot.contractVersion!==1
    ||!Number.isSafeInteger(snapshot.revision)||snapshot.revision<0||!Array.isArray(snapshot.items)||snapshot.items.length>4096
    ||snapshot.items.some(row=>!validState(row)||row.entityRevision>snapshot.revision)
    ||new Set(snapshot.items.map(mangaIndexKey)).size!==snapshot.items.length)throw new Error('고정 목록을 확인하지 못했습니다.');
}
export function adoptPins(authority:BookmarkAuthority,snapshot:PinSnapshot,connection=outboxConnection()){
  validatePinSnapshot(snapshot,authority);
  const store=read(authority,connection);
  if(store.snapshot?.epoch===snapshot.epoch&&store.snapshot.revision>snapshot.revision)return;
  write(authority,{...store,snapshot},connection);
}
export function visiblePins(authority:BookmarkAuthority):Array<MangaIndexIdentity&{pending:boolean}>{
  const store=read(authority),pins=new Map<string,MangaIndexIdentity&{pending:boolean}>();
  if(store.snapshot?.epoch===authority.epoch)for(const row of store.snapshot.items)if(row.desiredState)pins.set(mangaIndexKey(row),{...row,pending:false});
  for(const [key,intent]of Object.entries(store.intents)){
    if(intent.desired)pins.set(key,{...intent.identity,pending:true});else pins.delete(key);
  }
  return [...pins.values()];
}
export function pendingPins(authority:BookmarkAuthority){return Object.keys(read(authority).intents).length;}
export function queuePin(authority:BookmarkAuthority,identity:MangaIndexIdentity,desired:boolean){
  const store=read(authority),key=mangaIndexKey(identity),observed=store.snapshot?.epoch===authority.epoch?store.snapshot.items.find(row=>mangaIndexKey(row)===key):undefined;
  store.intents[key]={identity,desired,operationId:crypto.randomUUID(),epoch:authority.epoch,baseRevision:observed?.entityRevision??0,createdAt:new Date().toISOString()};
  write(authority,store);
}
const inFlight=new Map<string,Promise<void>>();
export function flushPins(authority:BookmarkAuthority):Promise<void>{
  const connection=outboxConnection(),key=storageKey(authority,connection);
  if(!connection||!key)return Promise.resolve();
  const existing=inFlight.get(key);if(existing)return existing;
  const job=deliver(authority,connection).finally(()=>inFlight.delete(key));inFlight.set(key,job);return job;
}
async function deliver(authority:BookmarkAuthority,connection:string){
  if(!pendingPins(authority))return;
  const path=`${INDEX_PATH}/pins?libraryId=${authority.libraryId}&epoch=${authority.epoch}`;
  const snapshot=await api<PinSnapshot>(path,undefined,undefined,'GET',true,connection);
  adoptPins(authority,snapshot,connection);
  for(const key of Object.keys(read(authority,connection).intents)){
    let intent=read(authority,connection).intents[key];if(!intent)continue;
    if(intent.epoch!==authority.epoch){
      intent={...intent,epoch:authority.epoch,baseRevision:snapshot.items.find(row=>mangaIndexKey(row)===key)?.entityRevision??0,operationId:crypto.randomUUID()};
      const store=read(authority,connection);store.intents[key]=intent;write(authority,store,connection);
    }
    for(let attempt=0;attempt<2;attempt++){
      if(read(authority,connection).intents[key]?.operationId!==intent.operationId)break;
      const body={libraryId:authority.libraryId,epoch:authority.epoch,contractVersion:1,operationId:intent.operationId,expectedRevision:intent.baseRevision,desiredState:intent.desired,value:intent.identity.value,label:intent.identity.label};
      let accepted:PinState;
      let cursor:number;
      try{
        const result=await api<PinState&{libraryId:string;epoch:number;contractVersion:number;revision:number}>(`${INDEX_PATH}/pins/${intent.identity.kind}/${intent.identity.namespace}`,undefined,body,'PUT',false,connection);
        if(result.libraryId!==authority.libraryId||result.epoch!==authority.epoch||result.contractVersion!==1||!validState(result)||mangaIndexKey(result)!==key||result.desiredState!==intent.desired||(intent.desired&&result.label!==intent.identity.label)||result.entityRevision<intent.baseRevision||!Number.isSafeInteger(result.revision)||result.revision<result.entityRevision)throw new Error('고정 저장 결과를 확인하지 못했습니다.');
        accepted=result;cursor=result.revision;
      }catch(error){
        const detail=error instanceof ApiError?error.details as {code?:string;current?:PinState;authorityCursor?:number}:null;
        const current=detail?.current;
        if(!(error instanceof ApiError)||error.status!==409||detail?.code!=='revisionConflict'||!current||!validState(current)||mangaIndexKey(current)!==key)throw error;
        if(current.desiredState===intent.desired&&(!intent.desired||current.label===intent.identity.label)){accepted=current;cursor=detail?.authorityCursor??current.entityRevision;}
        else{
          const store=read(authority,connection);if(store.intents[key]?.operationId!==intent.operationId)break;
          intent={...intent,operationId:crypto.randomUUID(),baseRevision:current.entityRevision};store.intents[key]=intent;write(authority,store,connection);
          continue;
        }
      }
      const store=read(authority,connection);
      if(store.intents[key]?.operationId===intent.operationId)delete store.intents[key];
      // Confirmation and retirement commit together; never downgrade an observed row.
      if(store.snapshot?.epoch===authority.epoch){
        const observed=store.snapshot.items.find(row=>mangaIndexKey(row)===key);
        if(!observed||observed.entityRevision<=accepted.entityRevision)store.snapshot.items=[...store.snapshot.items.filter(row=>mangaIndexKey(row)!==key),accepted];
        store.snapshot.revision=Math.max(store.snapshot.revision,cursor);
      }
      write(authority,store,connection);break;
    }
  }
  const latest=await api<PinSnapshot>(path,undefined,undefined,'GET',true,connection);
  adoptPins(authority,latest,connection);
}
