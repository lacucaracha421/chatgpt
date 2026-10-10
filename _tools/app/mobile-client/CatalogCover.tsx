import {useEffect,useRef,useState} from 'react';
import {afterDecode,arrive,type CardArrival} from './motion';
import {catalogImageTicket} from './catalogMedia';
import {catalogCoverDecoded,catalogPerfEnabled} from './catalogPerf';
import {useTabletCatalogMasked} from './catalogMask';
import type {CatalogItem} from './catalogModel';
import {observeCatalogCover} from './catalogCoverObservers';
import {tabletCatalogMasked} from './catalogMask';

/**
 * Cover URLs this session already resolved, by cover identity. A card that mounts again (a
 * 카탈로그 ⇄ 북마크 switch, a list coming back) paints its known cover on its first frame instead
 * of an empty box that fills in after a new ticket round trip.
 */
const coverUrls=new Map<string,string>();
/** Tickets a list preparation asked for and that are still on their way; a mounting cover joins them. */
const preparing=new Map<string,Promise<string|null>>();
const COVER_URLS_MAX=400;
const coverSource=(item:Pick<CatalogItem,'provider'|'providerWorkId'|'thumbnailUrl'>,revision:string)=>JSON.stringify([item.provider,item.providerWorkId,item.thumbnailUrl,revision]);
const validCoverUrl=(url:string)=>url.startsWith('https://app.lakomics.local/media-cache/')||(import.meta.env.DEV&&url.startsWith('data:image/'));
function rememberCover(source:string,url:string){
  coverUrls.delete(source);coverUrls.set(source,url);
  while(coverUrls.size>COVER_URLS_MAX)coverUrls.delete(coverUrls.keys().next().value!);
}

/**
 * Before a replacing list commits, resolve and decode the covers of its first screen, so the new
 * cards appear with their pictures (no empty boxes filling in one by one). Bounded by `capMs`;
 * covers not ready by then load as usual. Never throws.
 */
export async function prepareCatalogCovers(items:readonly Pick<CatalogItem,'provider'|'providerWorkId'|'thumbnailUrl'>[],revision:string,signal:AbortSignal,capMs:number,foreground=true){
  if(tabletCatalogMasked())return;
  const missing=items.filter(item=>item.thumbnailUrl&&!coverUrls.has(coverSource(item,revision)));
  if(!missing.length)return;
  let timer=0;
  const work=Promise.all(missing.map(async item=>{
    const source=coverSource(item,revision);
    const url=catalogImageTicket({workId:item.providerWorkId,revision,kind:'cover',index:0,url:item.thumbnailUrl!},signal,()=>foreground)
      .then(ticket=>{if(signal.aborted||!validCoverUrl(ticket.url))return null;rememberCover(source,ticket.url);return ticket.url;},()=>null)
      .finally(()=>{if(preparing.get(source)===url)preparing.delete(source);});
    preparing.set(source,url);
    const ready=await url;
    if(!ready)return;
    const image=new Image();image.src=ready;
    await image.decode?.();
  }).map(job=>job.catch(()=>{})));
  await Promise.race([work,new Promise<void>(resolve=>{timer=window.setTimeout(resolve,capMs);})]).finally(()=>window.clearTimeout(timer));
}
/** Tests start from an empty session. */
export function forgetCatalogCovers(){coverUrls.clear();preparing.clear();}
/** Whether every cover of `items` is already known, so a list can commit without preparing. */
export function catalogCoversKnown(items:readonly Pick<CatalogItem,'provider'|'providerWorkId'|'thumbnailUrl'>[],revision:string){
  return tabletCatalogMasked()||items.every(item=>!item.thumbnailUrl||coverUrls.has(coverSource(item,revision)));
}
/** A nearby cover stays subscribed through quick viewport exits; a far cover is canceled. */
export function CatalogCover({item,revision,active,onUrl,arrival}:{item:Pick<CatalogItem,'provider'|'providerWorkId'|'thumbnailUrl'>;revision:string;active:boolean;onUrl?(url:string|null):void;arrival?:CardArrival}){
  const privacy = useTabletCatalogMasked();
  const source=coverSource(item,revision);
  const [image,setImage]=useState<{source:string;url:string}|null>(null),[failed,setFailed]=useState<string|null>(null),[near,setNear]=useState(false),[decoded,setDecoded]=useState<string|null>(null),[retry,setRetry]=useState(0);
  const host=useRef<HTMLSpanElement>(null),picture=useRef<HTMLImageElement>(null),loaded=useRef<string|null>(null),visible=useRef(false);
  // Only a shown list paints remembered covers; a prewarmed (inactive) list loads no images.
  const known=active?coverUrls.get(source):undefined;
  useEffect(()=>{
    const element=host.current;if(!element)return;
    return observeCatalogCover(element,value=>{visible.current=value;},setNear);
  },[]);
  useEffect(()=>{
    if(privacy||!active||!near||!item.thumbnailUrl||loaded.current===source||coverUrls.has(source))return;setFailed(null);
    const controller=new AbortController();
    // A list preparation already asked for this cover: wait for that answer instead of asking twice.
    const joined=preparing.get(source);
    const ticketed=joined?joined.then(url=>url?{url}:catalogImageTicket({workId:item.providerWorkId,revision,kind:'cover',index:0,url:item.thumbnailUrl!},controller.signal,()=>visible.current))
      :catalogImageTicket({workId:item.providerWorkId,revision,kind:'cover',index:0,url:item.thumbnailUrl},controller.signal,()=>visible.current);
    void ticketed.then(ticket=>{
      if(controller.signal.aborted)return;
      if(!validCoverUrl(ticket.url))throw new Error('Invalid catalog cover');
      loaded.current=source;rememberCover(source,ticket.url);setImage({source,url:ticket.url});
    }).catch(()=>{if(!controller.signal.aborted)setFailed(source);});
    // A viewport exit does not change `near`: even an in-flight preload gets two rows to finish.
    return()=>controller.abort();
  },[source,active,near,privacy,retry]);
  const shown=!privacy&&failed!==source?(image?.source===source?image.url:known??null):null;
  useEffect(()=>{onUrl?.(shown);},[shown,onUrl]);
  useEffect(()=>{if(privacy||!item.thumbnailUrl||failed===source)arrival?.ready();},[privacy,item.thumbnailUrl,failed,source,arrival]);
  const settle=(element:HTMLImageElement)=>{
    if(picture.current!==element||!element.isConnected)return;
    arrival?.ready();arrive(element);
    setDecoded(source);
    if(host.current)catalogCoverDecoded(host.current);
  };
  return <span className="catalog-cover-image" ref={host} data-perf-image-pending={catalogPerfEnabled()&&!privacy&&!!item.thumbnailUrl&&failed!==source&&decoded!==source?"true":undefined} data-catalog-cover={item.thumbnailUrl?item.providerWorkId:undefined} data-catalog-decoded={shown&&decoded===source?'true':undefined}>{privacy?<span className="privacy-mask" aria-label="비공개 모드"/>:shown?<img key={source} ref={picture} src={shown} alt="" onLoad={event=>{const element=event.currentTarget;afterDecode(element,()=>settle(element));}} onError={()=>{
    // A remembered URL that no longer loads is forgotten and asked for again, once.
    if(image?.source!==source&&coverUrls.get(source)===shown){coverUrls.delete(source);setRetry(value=>value+1);return;}
    coverUrls.delete(source);arrival?.ready();loaded.current=null;setFailed(source);}}/>:null}</span>;
}
