import type {JustifiedGalleryRow} from '../src/assets/galleryRows';
import type {AssetRangeList} from './assetToc';

export type SparseRow<T> = JustifiedGalleryRow<T> & {startIndex:number; count:number; key:string; spacer?:boolean};
/** The work and number of slots depend on loaded rows/ranges, never on totalCount. */
export function sparseGalleryRows<T>(list:AssetRangeList, build:(start:number,length:number)=>SparseRow<T>[], size:(row:SparseRow<T>)=>number, fallbackPerItem:number):SparseRow<T>[] {
  const loaded=list.ranges.map(range=>({range,rows:build(range.startIndex,range.items.length)}));
  let height=0,count=0;
  for(const entry of loaded)for(const row of entry.rows){height+=size(row);count+=row.count;}
  const perItem=count?height/count:fallbackPerItem,rows:SparseRow<T>[]=[];
  let end=0;
  const gap=(start:number,count:number)=>{if(count>0)rows.push({key:`gap:${start}`,startIndex:start,count,spacer:true,items:[],height:Math.max(1,count*perItem)});};
  for(const entry of loaded) {
    gap(end,entry.range.startIndex-end);rows.push(...entry.rows);
    end=entry.range.startIndex+entry.range.items.length;
  }
  gap(end,list.toc.totalCount-end);
  return rows;
}
export type GalleryAnchor={id?:string; index:number; offset:number};
export function galleryAnchor<T extends {asset:{id:string}}>(rows:readonly SparseRow<T>[],top:number,size:(row:SparseRow<T>)=>number):GalleryAnchor|undefined {
  let start=0;
  for(const row of rows) {
    const height=size(row);
    if(start+height>top) {
      if(row.spacer) {
        const perItem=height/row.count,within=Math.min(row.count-1,Math.max(0,Math.floor((top-start)/perItem)));
        return {index:row.startIndex+within,offset:top-start-within*perItem};
      }
      return {id:row.items[0]?.asset.id,index:row.startIndex,offset:top-start};
    }
    start+=height;
  }
}
export function galleryAnchorTop<T extends {asset:{id:string}}>(rows:readonly SparseRow<T>[],anchor:GalleryAnchor,size:(row:SparseRow<T>)=>number):number|undefined {
  let start=0;
  for(const row of rows) {
    if(anchor.id&&row.items.some(item=>item.asset.id===anchor.id))return start+anchor.offset;
    if(!anchor.id&&anchor.index>=row.startIndex&&anchor.index<row.startIndex+row.count)
      return start+(row.spacer?(anchor.index-row.startIndex)*size(row)/row.count:0)+anchor.offset;
    start+=size(row);
  }
}

/** Decode the actual staged DOM images; those same elements enter the viewport on commit. */
export async function settleGalleryImages(elements:readonly HTMLImageElement[],signal:AbortSignal):Promise<void> {
  await Promise.all(elements.map(element=>new Promise<void>((resolve,reject)=>{
    let done=false;
    const cleanup=()=>{clearTimeout(timer);element.removeEventListener('load',decode);element.removeEventListener('error',settle);signal.removeEventListener('abort',cancel);};
    const settle=()=>{if(done)return;done=true;cleanup();resolve();};
    const cancel=()=>{if(done)return;done=true;cleanup();reject(new DOMException('Cancelled','AbortError'));};
    const decode=()=>{void (typeof element.decode==='function'?element.decode():Promise.resolve()).then(settle,settle);};
    // Broken thumbnails settle to the existing missing-media treatment, never trap a seek.
    const timer=setTimeout(()=>{
      if(done)return;done=true;cleanup();reject(new Error('썸네일을 준비하지 못했습니다. 다시 시도해 주세요.'));
    },18_000);
    element.addEventListener('load',decode);element.addEventListener('error',settle);signal.addEventListener('abort',cancel,{once:true});
    if(signal.aborted)cancel();else if(element.complete)decode();
  })));
}
