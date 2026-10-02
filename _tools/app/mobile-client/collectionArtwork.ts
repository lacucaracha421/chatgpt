/**
 * Collection artwork on the tablet: server tickets for published artwork, a small queue, the
 * Collections screen's memory of decoded covers, and hooks that hand plain URLs to the shared
 * PC pieces (shelf case, work case, manga book). Every URL is decoded before it replaces the one
 * on screen, so a change never blanks an image (DESIGN.md §12, No flash on change).
 */
import {createContext, useContext, useEffect, useRef, useState, type RefObject} from 'react';
import {native} from './transport';
import {mediaTicket} from './media';
import {collectionCover, type CollectionSummary} from './collectionModel';
import type {Ticket} from './types';
import {beginShelfForeground} from './shelfWarmActivity';

// Only visible artwork requests (covers, spines, performer portraits) enter this small queue,
// at most four at a time; native owns the disk cache.
let artworkActive=0;
const artworkQueue:(()=>void)[]=[];
function queued(run:()=>Promise<Ticket>,signal:AbortSignal):Promise<Ticket> {
  const finish=beginShelfForeground();
  return new Promise<Ticket>((resolve,reject)=>{
    const cancel=()=>{const index=artworkQueue.indexOf(start);if(index>=0)artworkQueue.splice(index,1);reject(new DOMException('Cancelled','AbortError'));};
    const start=()=>{if(signal.aborted){cancel();return;} artworkActive++;
      void run().then(resolve,reject).finally(()=>{signal.removeEventListener('abort',cancel);artworkActive--;while(artworkActive<4&&artworkQueue.length)artworkQueue.shift()!();});
    };
    if(signal.aborted){cancel();return;}
    signal.addEventListener('abort',cancel,{once:true}); if(artworkActive<4)start();else artworkQueue.push(start);
  }).finally(finish);
}
export function artworkTicket(item:CollectionSummary, artworkId:string|undefined|null, revision:string, original:boolean, signal:AbortSignal):Promise<Ticket> {
  return queued(()=>artworkId ? native<Ticket>('collectionArtwork',{collectionId:item.id,artworkId,variant:original?'original':'thumbnail',revision,digest:item.artworkVersions?.[artworkId]?.[original?'original':'thumbnail']??''},signal) : mediaTicket({id:item.coverAssetId!,kind:'image'},original?'original':'thumbnail',signal),signal);
}
/**
 * What identifies an artwork's bytes. A published digest names them exactly, and native keys its
 * cache by it, so a publication revision alone (every personal edit, such as Showcase, bumps it)
 * is not a new image. Without a digest the revision is the only version there is.
 */
export function artworkVersion(item:CollectionSummary,id:string|null|undefined,revision:string,original:boolean) {
  return id?item.artworkVersions?.[id]?.[original?'original':'thumbnail']||revision:'';
}
export function artworkSource(item:CollectionSummary,id:string|null|undefined,revision:string,original:boolean) {
  return JSON.stringify([item.id,id??null,item.coverAssetId??null,original?'original':'thumbnail',artworkVersion(item,id,revision,original)]);
}
/** Resolves once `url` is decoded (or cannot be), so a replacement never blanks the old image. */
export async function decoded(url:string) {
  const image=new Image();image.src=url;
  try{await image.decode?.();}catch{/* the element's own onError reports it */}
}
export const validArtworkUrl=(url:string)=>/^https:\/\//.test(url)||(import.meta.env.DEV&&url.startsWith('data:image/'));
export type LoadedArtwork = {source:string;url:string};
/** A decoded list cover is reused for this long unless its ticket says otherwise. */
const ARTWORK_KEEP_MS=4*60_000;
/**
 * The Collections screen's decoded list covers, by artwork source. A card that mounts again
 * (a type switched back, a list re-read) shows its cover in its first frame, and the covers a
 * type swap pre-decodes are handed to the cards instead of being requested twice.
 */
export class ArtworkMemory {
  private urls=new Map<string,{url:string;until:number}>();
  private loads=new Map<string,Promise<string>>();
  get(source:string){const hit=this.urls.get(source);if(hit&&hit.until>Date.now())return hit.url;this.urls.delete(source);return null;}
  put(source:string,ticket:Ticket){this.urls.set(source,{url:ticket.url,until:Date.now()+(ticket.expires_in?ticket.expires_in*1000:ARTWORK_KEEP_MS)});}
  forget(source:string){this.urls.delete(source);}
  /** A pre-decode of `source` still under way, if any. */
  pending(source:string){return this.loads.get(source)??null;}
  /** Join the first visible request too, so the list and Showcase do not fetch the same cover twice. */
  request(item:CollectionSummary,id:string|null|undefined,revision:string,original:boolean,signal:AbortSignal):Promise<Ticket>{
    const source=artworkSource(item,id,revision,original),remembered=this.get(source);
    if(remembered)return Promise.resolve({url:remembered});
    let load=this.loads.get(source);
    if(!load){
      load=artworkTicket(item,id,revision,original,signal).then(async ticket=>{
        if(!validArtworkUrl(ticket.url))throw new Error('Invalid artwork');
        await decoded(ticket.url);this.put(source,ticket);return ticket.url;
      }).finally(()=>{if(this.loads.get(source)===load)this.loads.delete(source);});
      this.loads.set(source,load);
    }
    const detach=()=>{if(this.loads.get(source)===load)this.loads.delete(source);};
    signal.addEventListener('abort',detach,{once:true});
    return load.then(url=>({url})).finally(()=>signal.removeEventListener('abort',detach));
  }
  /** Requests and decodes the list covers of `items` that are not ready yet. */
  preload(items:CollectionSummary[],revision:string,signal:AbortSignal){
    return Promise.all(items.map(item=>{
      const id=collectionCover(item),source=artworkSource(item,id,revision,false);
      if((!id&&!item.coverAssetId)||this.get(source))return undefined;
      const running=this.loads.get(source);if(running)return running.catch(()=>undefined);
      const load=artworkTicket(item,id,revision,false,signal).then(async ticket=>{
        if(!validArtworkUrl(ticket.url))throw new Error('Invalid artwork');
        await decoded(ticket.url);this.put(source,ticket);return ticket.url;
      }).finally(()=>{if(this.loads.get(source)===load)this.loads.delete(source);});
      this.loads.set(source,load);
      return load.catch(()=>undefined);
    }));
  }
}
export const ArtworkMemoryContext=createContext<ArtworkMemory|null>(null);
/**
 * A visible artwork that failed tries again after these delays, then stays failed until its tab
 * or visibility changes. A full native media queue ("media_busy") never started the request, so
 * it has its own, longer budget and is not shown as broken while it waits.
 */
export const ARTWORK_RETRY_MS=[1000,3000,10_000] as const;
export const ARTWORK_BUSY_RETRY_MS=2000, ARTWORK_BUSY_RETRIES=10;
export const mediaBusy=(error:unknown)=>(error as {details?:{code?:unknown}|null}|null)?.details?.code==='media_busy';
export type Retries={source:string;failed:number;busy:number};

/**
 * A list cover as a plain URL for the shared shelf case (`LightCase`). Like the grid's
 * `Artwork`: requested only while `host` is near the viewport, shared with the screen's memory
 * of decoded covers, retried on the same budget, and the shown URL stays until the next decodes.
 */
export function useCoverUrl(item:CollectionSummary,id:string|null|undefined,revision:string,active:boolean,host:RefObject<Element|null>):string|null {
  const memory=useContext(ArtworkMemoryContext);
  const source=artworkSource(item,id,revision,false);
  const [shown,setShown]=useState<LoadedArtwork|null>(()=>{const url=memory?.get(source);return url?{source,url}:null;});
  const [visible,setVisible]=useState(false),[attempt,setAttempt]=useState(0);
  const retries=useRef<Retries>({source,failed:0,busy:0}),timer=useRef(0);
  // Observed only while it may load (a case's spine waits for its front); the last answer stays meanwhile.
  useEffect(()=>{
    const element=host.current;if(!element||!active)return;
    if(!('IntersectionObserver' in window)){setVisible(true);return;}
    const observer=new IntersectionObserver(entries=>setVisible(entries.some(entry=>entry.isIntersecting)),{rootMargin:'120px'});
    observer.observe(element);return()=>observer.disconnect();
  },[host,active]);
  useEffect(()=>()=>window.clearTimeout(timer.current),[]);
  useEffect(()=>{
    if(!active||!visible){retries.current={source,failed:0,busy:0};return;}
    if((!id&&!item.coverAssetId)||shown?.source===source)return;
    const controller=new AbortController();
    const request=memory?.request(item,id,revision,false,controller.signal)??artworkTicket(item,id,revision,false,controller.signal).then(async ticket=>{
      if(!validArtworkUrl(ticket.url))throw new Error('Invalid artwork');await decoded(ticket.url);return ticket;
    });
    void request.then(ticket=>{if(!controller.signal.aborted)setShown({source,url:ticket.url});}).catch(error=>{
      if(controller.signal.aborted)return;
      if(retries.current.source!==source)retries.current={source,failed:0,busy:0};
      const state=retries.current,busy=mediaBusy(error)&&state.busy<ARTWORK_BUSY_RETRIES;
      const delay=busy?ARTWORK_BUSY_RETRY_MS:ARTWORK_RETRY_MS[state.failed];
      if(delay===undefined)return;
      if(busy)state.busy++;else state.failed++;
      window.clearTimeout(timer.current);timer.current=window.setTimeout(()=>setAttempt(value=>value+1),delay);
    });
    return()=>controller.abort();
  },[source,active,visible,attempt]);// eslint-disable-line react-hooks/exhaustive-deps
  // A work without any cover shows the case's own material; one whose cover changed keeps the old one until the new decodes.
  return !id&&!item.coverAssetId?null:shown?.url??null;
}

/** `asset`: without an artwork id, fall back to the work's cover asset (an older publication). */
export type ArtworkRequest={id:string|null|undefined;original:boolean;asset?:boolean};
/**
 * One work's artwork as plain URLs, by name (front, spine, back, hero…). With `atomic`, the set
 * changes only once every requested image is decoded or has failed, so a work's faces swap
 * together; otherwise each URL appears as soon as it is ready (the manga bookcase's spines).
 * `ready` says whether the URLs belong to the current request.
 */
export function useArtworkSet(item:CollectionSummary|null,requests:Record<string,ArtworkRequest>,revision:string,active:boolean,atomic=true):{urls:Record<string,string>;key:string;ready:boolean} {
  const entries=Object.entries(requests).filter(([,request])=>!!request.id||(!!request.asset&&!!item?.coverAssetId));
  const key=item?JSON.stringify([item.id,entries.map(([name,request])=>[name,artworkSource(item,request.id,revision,request.original)])]):'';
  const [state,setState]=useState<{key:string;urls:Record<string,string>}>({key:'',urls:{}});
  const latest=useRef({item,entries,revision});latest.current={item,entries,revision};
  useEffect(()=>{
    const {item:work,entries:wanted,revision:version}=latest.current;
    if(!active||!work||state.key===key)return;
    const controller=new AbortController();
    const load=([name,request]:[string,ArtworkRequest])=>artworkTicket(work,request.id,version,request.original,controller.signal).then(async ticket=>{
      if(!validArtworkUrl(ticket.url))throw new Error('Invalid artwork');
      await decoded(ticket.url);return [name,ticket.url] as const;
    }).catch(()=>null);
    if(atomic){
      void Promise.all(wanted.map(load)).then(values=>{
        if(!controller.signal.aborted)setState({key,urls:Object.fromEntries(values.filter((value):value is readonly [string,string]=>!!value))});
      });
    } else {
      // Spines that are already shown stay; new ones join as they decode.
      const kept=state.urls;
      setState({key,urls:Object.fromEntries(wanted.flatMap(([name])=>kept[name]?[[name,kept[name]]]:[]))});
      for(const entry of wanted)if(!kept[entry[0]])void load(entry).then(value=>{if(value&&!controller.signal.aborted)setState(current=>current.key===key?{key,urls:{...current.urls,[value[0]]:value[1]}}:current);});
    }
    return()=>controller.abort();
  },[key,active]);// eslint-disable-line react-hooks/exhaustive-deps
  return {urls:state.urls,key:state.key,ready:state.key===key};
}

/**
 * Performer portrait images (StashDB / Commons) by content hash, served through the Home cover
 * ticket (`homeCover`). Decoded URLs are kept for the ticket's life, so every row that shows the
 * same performer, and a row that mounts again, shows it in its first frame; rows asking for the
 * same hash share one request, which is cancelled only when all of them have left.
 */
const portraitUrls=new Map<string,{url:string;until:number}>();
const portraitLoads=new Map<string,{promise:Promise<string>;controller:AbortController;users:number}>();
function rememberedPortrait(sha256:string){const hit=portraitUrls.get(sha256);if(hit&&hit.until>Date.now())return hit.url;portraitUrls.delete(sha256);return null;}
function loadPortrait(sha256:string,signal:AbortSignal):Promise<string> {
  const hit=rememberedPortrait(sha256);if(hit)return Promise.resolve(hit);
  let load=portraitLoads.get(sha256);
  if(!load){
    const controller=new AbortController();
    const entry:{promise:Promise<string>;controller:AbortController;users:number}={controller,users:0,promise:queued(()=>native<Ticket>('homeCover',{sha256},controller.signal),controller.signal).then(async ticket=>{
      if(!validArtworkUrl(ticket.url))throw new Error('Invalid portrait');
      await decoded(ticket.url);
      portraitUrls.set(sha256,{url:ticket.url,until:Date.now()+(ticket.expires_in?ticket.expires_in*1000:ARTWORK_KEEP_MS)});
      return ticket.url;
    }).finally(()=>{if(portraitLoads.get(sha256)===entry)portraitLoads.delete(sha256);})};
    portraitLoads.set(sha256,entry);load=entry;
  }
  const shared=load;shared.users++;
  const detach=()=>{if(--shared.users>0)return;shared.controller.abort();if(portraitLoads.get(sha256)===shared)portraitLoads.delete(sha256);};
  signal.addEventListener('abort',detach,{once:true});
  return shared.promise.finally(()=>signal.removeEventListener('abort',detach));
}
/** Forget remembered portraits (tests). */
export function resetPortraitMemory(){portraitUrls.clear();portraitLoads.clear();}

/**
 * A performer portrait image as a decoded URL. A new hash keeps the shown image until the next
 * one is decoded; `failed` says the current hash could not be shown, so the caller falls back.
 */
export function usePortraitUrl(sha256:string|null,active:boolean):{url:string|null;failed:boolean} {
  const [shown,setShown]=useState<{sha:string;url:string}|null>(()=>{const url=sha256&&rememberedPortrait(sha256);return url&&sha256?{sha:sha256,url}:null;});
  const [failed,setFailed]=useState<string|null>(null);
  useEffect(()=>{
    if(!active||!sha256||shown?.sha===sha256)return;
    const hit=rememberedPortrait(sha256);if(hit){setShown({sha:sha256,url:hit});return;}
    const controller=new AbortController();
    void loadPortrait(sha256,controller.signal).then(url=>{if(!controller.signal.aborted)setShown({sha:sha256,url});},()=>{if(!controller.signal.aborted)setFailed(sha256);});
    return()=>controller.abort();
  },[sha256,active,shown?.sha]);
  return {url:sha256&&active&&failed!==sha256?shown?.url??null:null,failed:!!sha256&&failed===sha256};
}
