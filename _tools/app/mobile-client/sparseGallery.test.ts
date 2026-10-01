import {expect,it,vi} from 'vitest';
import {galleryAnchor,galleryAnchorTop,settleGalleryImages,sparseGalleryRows,type SparseRow} from './sparseGallery';
import type {AssetRangeList} from './assetToc';
const size=(row:SparseRow<{asset:{id:string}}>)=>row.height;
const list=(total:number):AssetRangeList=>({toc:{tocVersion:1,listGeneration:'g',sort:'newest',totalCount:total,buckets:[{key:'2026-09',startIndex:0,count:total,startCursor:null}]},ranges:[{startIndex:0,items:[{id:'a',kind:'image'}],nextCursor:'1',hasMore:true}]});
it('creates one spacer for 49,999 unloaded assets with no per-item work',()=>{
  let calls=0;
  const rows=sparseGalleryRows(list(50_000),()=>{calls++;return [{height:200,startIndex:0,count:1,key:'a',items:[{asset:{id:'a'}}]}];},size,100);
  expect(rows).toHaveLength(2);expect(calls).toBe(1);expect(rows[1].items).toHaveLength(0);expect(rows[1].count).toBe(49_999);expect(rows[1].height).toBe(49_999*200);
});
it('preserves the visible asset and its exact pixel offset when a spacer above becomes real rows',()=>{
  const before:SparseRow<{asset:{id:string}}>[]=[{key:'gap:0',spacer:true,startIndex:0,count:100,height:1000,items:[]},{key:'visible',startIndex:100,count:1,height:200,items:[{asset:{id:'visible'}}]}];
  const anchor=galleryAnchor(before,1073,size)!;
  expect(anchor).toEqual({id:'visible',index:100,offset:73});
  const after=[{key:'above',startIndex:0,count:100,height:1470,items:[{asset:{id:'above'}}]},before[1]];
  expect(galleryAnchorTop(after,anchor,size)).toBe(1543);
});
it('keeps the estimated index and offset when the viewport was inside a spacer',()=>{
  const rows:SparseRow<{asset:{id:string}}>[]=[{key:'gap',spacer:true,startIndex:0,count:100,height:1000,items:[]}];
  const anchor=galleryAnchor(rows,235,size)!;expect(anchor).toEqual({index:23,offset:5});
  expect(galleryAnchorTop([{...rows[0],height:2000}],anchor,size)).toBe(465);
});
it('rejects thumbnail preparation that times out instead of moving to unfinished images',async()=>{
  vi.useFakeTimers();
  try {
    const image=document.createElement('img');image.src='https://test.invalid/image';
    const settled=expect(settleGalleryImages([image],new AbortController().signal)).rejects.toThrow('썸네일을 준비하지 못했습니다');
    await vi.advanceTimersByTimeAsync(18_000);await settled;
  } finally {vi.useRealTimers();}
});
