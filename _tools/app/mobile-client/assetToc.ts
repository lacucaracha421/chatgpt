import {useCallback, useEffect, useRef, type Dispatch, type SetStateAction} from 'react';
import {api, errorText} from './transport';
import {normalizePage, pagePath} from './model';
import {albumPage, type AlbumAssetPage} from './albumModel';
import {ASSET_FILTER_VERSION, hasActiveFilters, sortOf} from './assetFilters';
import type {Asset, AssetFiltersValue, Page, View} from './types';

export type AssetTocBucket = {key:string; startIndex:number; count:number; startCursor:string|null};
export type AssetToc = {tocVersion:1; listGeneration:string; totalCount:number; sort:'newest'|'oldest'; utcOffsetMinutes?:number; buckets:AssetTocBucket[]};
export type AssetRange = {startIndex:number; items:Asset[]; nextCursor:string|null; hasMore:boolean};
export type AssetRangeList = {toc:AssetToc; ranges:AssetRange[]};
export type AssetTocPage = {tocRequest?:Promise<AssetToc|null>; assetRanges?:AssetRangeList};
export type SparseGallerySource = AssetRangeList & {
  load(index:number, count:number, signal:AbortSignal, prepare?:(items:Asset[], signal:AbortSignal, startIndex:number)=>Promise<Asset[]>, enough?:(range:AssetRange)=>boolean):Promise<boolean>;
  reportError(message:string):void;
};

export function supportsAssetToc(view:View) {
  return view.tab==='library' && !view.root && !view.characters && !view.revisit;
}
export function assetTocPath(view:View, filters:AssetFiltersValue, offset=-new Date().getTimezoneOffset()) {
  const [path, query]=pagePath(view,null,filters).split('?');
  const params=new URLSearchParams(query);
  params.delete('limit'); params.set('toc','1'); params.set('utcOffsetMinutes',String(offset));
  return `${path}?${params}`;
}
/** Refuse malformed tables rather than assigning items to an incorrect global position. */
export function validAssetToc(value:unknown):value is AssetToc {
  if(!value || typeof value!=='object')return false;
  const toc=value as AssetToc;
  if(toc.tocVersion!==1 || typeof toc.listGeneration!=='string' || !toc.listGeneration || !Number.isSafeInteger(toc.totalCount) || toc.totalCount<0 || !['newest','oldest'].includes(toc.sort) || !Array.isArray(toc.buckets))return false;
  if(toc.utcOffsetMinutes!==undefined && (!Number.isInteger(toc.utcOffsetMinutes)||Math.abs(toc.utcOffsetMinutes)>1440))return false;
  let end=0;
  for(const bucket of toc.buckets) {
    if(!bucket || typeof bucket!=='object')return false;
    if(typeof bucket.key!=='string' || bucket.startIndex!==end || !Number.isSafeInteger(bucket.count) || bucket.count<=0 || !(bucket.startCursor===null || typeof bucket.startCursor==='string'&&!!bucket.startCursor))return false;
    if(end>0&&bucket.startCursor===null)return false;
    end+=bucket.count;
  }
  return end===toc.totalCount;
}
export async function readAssetToc(view:View, filters:AssetFiltersValue, signal:AbortSignal):Promise<AssetToc|null> {
  try {
    const value=await api<unknown>(assetTocPath(view,filters),signal);
    return !signal.aborted&&validAssetToc(value)&&value.sort===sortOf(filters)?value:null;
  } catch { return null; } // Optional capability: old and offline servers keep cursor paging.
}
export async function readTocPage(view:View, filters:AssetFiltersValue, cursor:string|null, signal:AbortSignal):Promise<Page> {
  const reply=await api<AlbumAssetPage&Page&{listGeneration?:string}>(pagePath(view,cursor,filters),signal);
  const page=view.album?albumPage(reply):normalizePage(reply);
  if(hasActiveFilters(filters)&&page.filter_version!==ASSET_FILTER_VERSION)throw new Error('자산 필터 응답을 확인할 수 없습니다. 서버를 업데이트해 주세요.');
  return {...page,list_generation:reply.listGeneration};
}
export class AssetListChanged extends Error {}
const aborted=()=>new DOMException('Cancelled','AbortError');
export function bucketAt(toc:AssetToc, index:number):AssetTocBucket|undefined {
  let left=0,right=toc.buckets.length-1;
  while(left<=right) {
    const middle=(left+right)>>>1,bucket=toc.buckets[middle];
    if(index<bucket.startIndex)right=middle-1;
    else if(index>=bucket.startIndex+bucket.count)left=middle+1;
    else return bucket;
  }
}
export function rangeAt(ranges:readonly AssetRange[], index:number) {
  return ranges.find(range=>index>=range.startIndex&&index<range.startIndex+range.items.length);
}
/** Merge only materialized assets; holes never become arrays of placeholder objects. */
export function mergeAssetRanges(ranges:readonly AssetRange[], added:AssetRange):AssetRange[] {
  const ordered=[...ranges,added].sort((a,b)=>a.startIndex-b.startIndex),result:AssetRange[]=[];
  for(const range of ordered) {
    const previous=result[result.length-1];
    if(!previous || previous.startIndex+previous.items.length<range.startIndex) {result.push({...range,items:[...range.items]});continue;}
    const offset=range.startIndex-previous.startIndex;
    for(let i=0;i<range.items.length;i++)previous.items[offset+i]={...previous.items[offset+i],...range.items[i]};
    if(range.startIndex+range.items.length>=previous.startIndex+previous.items.length) {
      previous.nextCursor=range.nextCursor;previous.hasMore=range.hasMore;
    }
  }
  return result;
}
/** Start at the closest cursor that precedes the target, then walk forward in order. */
export async function fetchAssetRange(list:AssetRangeList, index:number, count:number, read:(cursor:string|null,signal:AbortSignal)=>Promise<Page>, signal:AbortSignal):Promise<AssetRange> {
  const bucket=bucketAt(list.toc,index);
  if(!bucket)throw new Error('목록 위치를 찾지 못했습니다.');
  const existing=rangeAt(list.ranges,index),end=Math.min(list.toc.totalCount,index+count);
  if(existing&&existing.startIndex+existing.items.length>=end)return existing;
  let start=bucket.startIndex,cursor=bucket.startCursor;
  for(const range of list.ranges) {
    const tail=range.startIndex+range.items.length;
    if(range.hasMore&&range.nextCursor&&tail<=index&&tail>=start){start=tail;cursor=range.nextCursor;}
  }
  // Continue the tail of a partially covered destination screen.
  if(existing&&existing.hasMore&&existing.nextCursor) {start=existing.startIndex+existing.items.length;cursor=existing.nextCursor;}
  let items:Asset[]=[],hasMore=true,nextCursor=cursor;
  const cursors=new Set<string|null>();
  while(start+items.length<end && hasMore) {
    if(signal.aborted)throw aborted();
    if(cursors.has(nextCursor))throw new Error('목록 커서가 진행되지 않습니다.');
    cursors.add(nextCursor);
    const page=await read(nextCursor,signal);
    if(signal.aborted)throw aborted();
    if(page.list_generation!==list.toc.listGeneration)throw new AssetListChanged();
    if(!page.items.length || start+items.length+page.items.length>list.toc.totalCount)throw new AssetListChanged();
    items.push(...page.items);hasMore=page.has_more;nextCursor=page.next_cursor;
  }
  if(start+items.length<end)throw new AssetListChanged();
  const added={startIndex:start,items,nextCursor,hasMore};
  return rangeAt(mergeAssetRanges(list.ranges,added),index)!;
}

type TocHost = Page & AssetTocPage & {version:number; generation:string|null; view:View; filters:AssetFiltersValue; cursor:string|null};
/** App keeps the loaded ranges with its cached list, selection and viewer source. */
export function useAssetToc<T extends TocHost>(page:T, setPage:Dispatch<SetStateAction<T>>, reload:()=>void, onError:(message:string)=>void):SparseGallerySource|undefined {
  const latest=useRef({page,reload,onError});latest.current={page,reload,onError};
  useEffect(()=>{
    if(!page.tocRequest || page.cursor)return;
    let live=true;
    void page.tocRequest.then(toc=>{
      const current=latest.current.page;
      if(!live || !toc || current.version!==page.version)return;
      if(toc.listGeneration!==current.generation || current.items.length>toc.totalCount) {latest.current.reload();return;}
      setPage(previous=>previous.version!==page.version?previous:{...previous,assetRanges:{toc,ranges:previous.assetRanges?.ranges??(previous.items.length?[{startIndex:0,items:previous.items,nextCursor:previous.next_cursor,hasMore:previous.has_more}]:[])}});
    });
    return()=>{live=false;};
  },[page.tocRequest,page.version,page.cursor,setPage]);
  const load=useCallback(async(index:number,count:number,signal:AbortSignal,prepare?:(items:Asset[],signal:AbortSignal,startIndex:number)=>Promise<Asset[]>,enough?:(range:AssetRange)=>boolean)=>{
    const current=latest.current.page,list=current.assetRanges;
    if(!list || signal.aborted)return false;
    try {
      let added=await fetchAssetRange(list,index,Math.max(1,count), (cursor,signal)=>readTocPage(current.view,current.filters,cursor,signal),signal);
      while(enough&&!enough(added)&&added.startIndex+added.items.length<list.toc.totalCount) {
        count*=2;
        added=await fetchAssetRange({...list,ranges:mergeAssetRanges(list.ranges,added)},index,count,(cursor,signal)=>readTocPage(current.view,current.filters,cursor,signal),signal);
      }
      if(prepare) {
        added={...added,items:await prepare(added.items,signal,added.startIndex)};
      }
      if(signal.aborted || latest.current.page.version!==current.version)return false;
      setPage(previous=>{
        if(previous.version!==current.version || !previous.assetRanges)return previous;
        const previews=new Map(previous.items.map(asset=>[asset.id,asset]));
        const ranges=mergeAssetRanges(previous.assetRanges.ranges,added).map(range=>({...range,items:range.items.map(asset=>({...previews.get(asset.id),...asset,preview:asset.preview??previews.get(asset.id)?.preview}))}));
        return {...previous,items:ranges.flatMap(range=>range.items),assetRanges:{toc:previous.assetRanges.toc,ranges}};
      });
      latest.current.onError('');return true;
    } catch(reason) {
      if(signal.aborted || latest.current.page.version!==current.version)return false;
      if(reason instanceof AssetListChanged)latest.current.reload();
      else latest.current.onError(errorText(reason));
      return false;
    }
  },[setPage]);
  return page.assetRanges?{...page.assetRanges,load,reportError:message=>latest.current.onError(message)}:undefined;
}
