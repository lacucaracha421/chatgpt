import {useCallback, useRef, type Dispatch, type SetStateAction} from 'react';
import {api, errorText} from './transport';
import {AssetListChanged, fetchAssetRange, mergeAssetRanges, validAssetToc, type AssetRange, type AssetRangeList, type SparseGallerySource} from './assetToc';
import type {Asset, Page} from './types';

export type ScopedAssetPage = Page & {assetRanges?:AssetRangeList};

/** Optional TOC capability; offline/older servers keep their ordinary cursor pages. */
export async function readScopedToc(path:string, signal:AbortSignal) {
  try {
    const value=await api<unknown>(path,signal);
    return !signal.aborted&&validAssetToc(value)?value:null;
  } catch {return null;}
}
export async function withScopedToc<T extends ScopedAssetPage>(page:Promise<T>, toc:ReturnType<typeof readScopedToc>, sort:'newest'|'oldest'):Promise<T> {
  const [result,table]=await Promise.all([page,toc]);
  if(!table||table.sort!==sort)return result;
  if(table.listGeneration!==result.list_generation||result.items.length>table.totalCount)throw new AssetListChanged('목록이 변경되었습니다. 새로고침해 주세요.');
  return {...result,assetRanges:{toc:table,ranges:result.items.length?[{startIndex:0,items:result.items,nextCursor:result.next_cursor,hasMore:result.has_more}]:[]}};
}
export function readyScopedAsset<T extends ScopedAssetPage>(page:T, asset:Asset):T {
  const ready=(items:Asset[])=>items.map(old=>old.id===asset.id?{...old,...asset}:old);
  return {...page,items:ready(page.items),assetRanges:page.assetRanges?{...page.assetRanges,ranges:page.assetRanges.ranges.map(range=>({...range,items:ready(range.items)}))}:undefined};
}

/** Artist and Character scopes use the phase-1 range reader with their own route identity. */
export function useScopedAssetToc<T extends ScopedAssetPage>(page:T|undefined, setPage:Dispatch<SetStateAction<T|undefined>>, enabled:boolean,
  read:(cursor:string|null,signal:AbortSignal)=>Promise<T>, reload:()=>void, onError:(message:string)=>void,
  onRejected?:(reason:unknown,signal:AbortSignal)=>Promise<boolean>):SparseGallerySource|undefined {
  const latest=useRef({page,enabled,read,reload,onError,onRejected});latest.current={page,enabled,read,reload,onError,onRejected};
  const load=useCallback(async(index:number,count:number,signal:AbortSignal,prepare?:(items:Asset[],signal:AbortSignal,startIndex:number)=>Promise<Asset[]>,enough?:(range:AssetRange)=>boolean)=>{
    const current=latest.current,list=current.page?.assetRanges;
    if(!current.enabled||!list||signal.aborted)return false;
    const live=()=>!signal.aborted&&latest.current.enabled&&latest.current.page?.assetRanges?.toc===list.toc;
    try {
      let added=await fetchAssetRange(list,index,Math.max(1,count),current.read,signal);
      while(enough&&!enough(added)&&added.startIndex+added.items.length<list.toc.totalCount) {
        count*=2;
        added=await fetchAssetRange({...list,ranges:mergeAssetRanges(list.ranges,added)},index,count,current.read,signal);
      }
      if(prepare)added={...added,items:await prepare(added.items,signal,added.startIndex)};
      if(!live())return false;
      setPage(previous=>{
        if(!previous?.assetRanges||previous.assetRanges.toc!==list.toc)return previous;
        const previews=new Map(previous.items.map(asset=>[asset.id,asset]));
        const ranges=mergeAssetRanges(previous.assetRanges.ranges,added).map(range=>({...range,items:range.items.map(asset=>({...previews.get(asset.id),...asset,preview:asset.preview??previews.get(asset.id)?.preview}))}));
        return {...previous,items:ranges.flatMap(range=>range.items),assetRanges:{toc:list.toc,ranges}};
      });
      latest.current.onError('');return true;
    } catch(reason) {
      if(!live())return false;
      if(await current.onRejected?.(reason,signal)||!live())return false;
      if(reason instanceof AssetListChanged)latest.current.reload();
      else latest.current.onError(errorText(reason));
      return false;
    }
  },[setPage]);
  return page?.assetRanges?{...page.assetRanges,load,reportError:message=>latest.current.onError(message)}:undefined;
}
