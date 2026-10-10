import {api} from './transport';
import type {Asset} from './types';
import {DESCRIPTION_SEARCH_LIMIT} from '../src/assets/descriptionSearch';

/** 내용 검색 on the tablet: the server ranks the PC-published Korean captions (NL-SEARCH-001 option A). */
export {DESCRIPTION_PREVIEW_COUNT,DESCRIPTION_SEARCH_LIMIT,DESCRIPTION_TYPING_PAUSE_MS,descriptionQueryReady} from '../src/assets/descriptionSearch';
export const DESCRIPTION_PATH='/v1/library/search/description';
/** What the page loader keeps beside the rows of a 내용 검색 view. */
export type DescriptionMeta={ready:boolean;gated:boolean};
export type DescriptionAnswer=DescriptionMeta&{items:Asset[]};
export type DescriptionRequest={query:string;force:boolean};

export function descriptionPath({query,force}:DescriptionRequest,limit=DESCRIPTION_SEARCH_LIMIT) {
  const params=new URLSearchParams({q:query.trim().slice(0,200),limit:String(limit)});
  if(force)params.set('force','true');
  return `${DESCRIPTION_PATH}?${params}`;
}
/** Anything the server did not state is "not ready", never a result. */
export function descriptionMeta(reply:unknown):DescriptionMeta {
  const value=(typeof reply==='object'&&reply!==null?reply:{}) as {ready?:unknown;gated?:unknown};
  return {ready:value.ready===true,gated:value.gated===true};
}

const CACHE_LIMIT=24;
const caches=new Map<string,Map<string,{promise:Promise<DescriptionAnswer>;answer?:DescriptionAnswer}>>();
const keyOf=({query,force}:DescriptionRequest,limit:number)=>`${force?'force':'gated'}:${limit}:${query.trim()}`;
export function cachedDescription(endpoint:string,request:DescriptionRequest,limit=DESCRIPTION_SEARCH_LIMIT):DescriptionAnswer|undefined {
  return caches.get(endpoint)?.get(keyOf(request,limit))?.answer;
}
/**
 * One finished or in-flight answer per endpoint, text and force. Failures and "not ready" answers are
 * not kept, so the next ask (or the captions arriving) is read fresh.
 */
export function readDescription(endpoint:string,request:DescriptionRequest,limit=DESCRIPTION_SEARCH_LIMIT):Promise<DescriptionAnswer> {
  let cache=caches.get(endpoint);
  if(!cache)caches.set(endpoint,cache=new Map());
  const key=keyOf(request,limit),existing=cache.get(key);
  if(existing){cache.delete(key);cache.set(key,existing);return existing.promise;}
  const entry:{promise:Promise<DescriptionAnswer>;answer?:DescriptionAnswer}={promise:api<{items?:Asset[]}>(descriptionPath(request,limit),undefined,undefined,undefined,false,endpoint).then(reply=>({
    ...descriptionMeta(reply),items:Array.isArray(reply?.items)?reply.items.filter(item=>typeof item?.id==='string'):[]}))};
  entry.promise.then(answer=>{if(answer.ready)entry.answer=answer;else if(cache!.get(key)===entry)cache!.delete(key);},()=>{if(cache!.get(key)===entry)cache!.delete(key);});
  cache.set(key,entry);
  while(cache.size>CACHE_LIMIT)cache.delete(cache.keys().next().value!);
  return entry.promise;
}
