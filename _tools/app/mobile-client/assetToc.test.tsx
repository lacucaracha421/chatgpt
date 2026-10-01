import {act, cleanup, renderHook, waitFor} from '@testing-library/react';
import {useState} from 'react';
import {afterEach, describe, expect, it, vi} from 'vitest';
import {AssetListChanged, assetTocPath, fetchAssetRange, mergeAssetRanges, readAssetToc, useAssetToc, validAssetToc, type AssetRangeList, type AssetToc, type AssetTocPage} from './assetToc';
import {EMPTY_FILTERS} from './assetFilters';
import {buildScrubberModel} from './scrubberModel';
import type {Asset, Page, View} from './types';

const mocks=vi.hoisted(()=>({api:vi.fn()}));
vi.mock('./transport',()=>({api:mocks.api,errorText:(error:Error)=>error.message}));
afterEach(()=>{cleanup();vi.clearAllMocks();});
const G='a'.repeat(64),view:View={tab:'library',title:'All'};
const assets=(start:number,count:number):Asset[]=>Array.from({length:count},(_,i)=>({id:String(start+i),kind:'image',thumbnail_available:false}));
const toc:AssetToc={tocVersion:1,listGeneration:G,totalCount:1000,sort:'newest',buckets:[{key:'2026-09',startIndex:0,count:600,startCursor:null},{key:'2025-12',startIndex:600,count:400,startCursor:'bucket-600'}]};
const initial:AssetRangeList={toc,ranges:[{startIndex:0,items:assets(0,40),nextCursor:'40',hasMore:true}]};
const reply=(start:number,count=40):Page=>({items:assets(start,count),next_cursor:String(start+count),has_more:start+count<1000,list_generation:G});

it('keeps the total and bucket labels fixed as loaded ranges grow',()=>{
  const before=buildScrubberModel({kind:'toc',...toc});
  const after=mergeAssetRanges(initial.ranges,{startIndex:600,items:assets(600,40),nextCursor:'640',hasMore:true});
  expect(after.flatMap(range=>range.items)).toHaveLength(80);
  expect(before.total).toBe(1000);
  expect(before.ticks).toEqual(buildScrubberModel({kind:'toc',...toc}).ticks);
  expect(before.ticks.map(tick=>[tick.index,tick.label])).toEqual([[0,'2026'],[600,'2025']]);
  expect(before.labelAt(599)).toBe('2026년 9월');expect(before.labelAt(600)).toBe('2025년 12월');
});
it('uses the bucket start cursor and includes the bucket first item',async()=>{
  const read=vi.fn(async()=>reply(600)),controller=new AbortController();
  const range=await fetchAssetRange(initial,600,40,read,controller.signal);
  expect(read).toHaveBeenCalledWith('bucket-600',controller.signal);
  expect(range.startIndex).toBe(600);expect(range.items[0].id).toBe('600');
});
it('walks from the nearest known tail to reach an index inside a bucket',async()=>{
  const list={...initial,ranges:mergeAssetRanges(initial.ranges,{startIndex:600,items:assets(600,40),nextCursor:'640',hasMore:true})};
  const read=vi.fn(async(cursor:string|null)=>reply(Number(cursor)));
  const range=await fetchAssetRange(list,690,30,read,new AbortController().signal);
  expect(read.mock.calls.map(call=>call[0])).toEqual(['640','680']);
  expect(range.items[690-range.startIndex].id).toBe('690');
});
it('refuses changed generations before publishing any fetched rows',async()=>{
  await expect(fetchAssetRange(initial,600,40,async()=>({...reply(600),list_generation:'b'.repeat(64)}),new AbortController().signal)).rejects.toBeInstanceOf(AssetListChanged);
});
it('keeps query filters, sort, album identity and the current device offset on TOC requests',()=>{
  const filters={media:'videos' as const,aspect:'portrait' as const,duration:'under_30s' as const,sort:'oldest' as const};
  const url=new URL(assetTocPath({...view,classification:'folder'},filters,540),'https://test');
  expect(Object.fromEntries(url.searchParams)).toMatchObject({toc:'1',utcOffsetMinutes:'540',sort:'oldest',classification_id:'folder',media_kind:'videos',aspect_ratio:'portrait',duration_ms_max:'30000'});
  expect(url.searchParams.has('cursor')).toBe(false);expect(url.searchParams.has('limit')).toBe(false);
  const album=new URL(assetTocPath({...view,album:{id:'a',libraryId:'l',epoch:4}},EMPTY_FILTERS),'https://test');
  expect(album.pathname).toBe('/v1/albums/assets');expect(Object.fromEntries(album.searchParams)).toMatchObject({albumId:'a',libraryId:'l',epoch:'4',utcOffsetMinutes:String(-new Date().getTimezoneOffset())});
});
it('accepts UTC buckets without an offset and rejects overlapping or truncated TOCs',()=>{
  expect(validAssetToc(toc)).toBe(true);
  expect(validAssetToc({...toc,totalCount:999})).toBe(false);
  expect(validAssetToc({...toc,buckets:[toc.buckets[0],{...toc.buckets[1],startIndex:590}]})).toBe(false);
  expect(validAssetToc({...toc,buckets:[null]})).toBe(false);
});
it.each([400,404,422,'offline'])('silently falls back when TOC fails: %s',async(status)=>{
  mocks.api.mockRejectedValueOnce(new Error(String(status)));
  expect(await readAssetToc(view,EMPTY_FILTERS,new AbortController().signal)).toBeNull();
});

describe('App range integration',()=>{
  type Host=Page&AssetTocPage&{version:number;generation:string;view:View;filters:typeof EMPTY_FILTERS;cursor:null};
  const seed=():Host=>({...reply(0),version:1,generation:G,view,filters:EMPTY_FILTERS,cursor:null,tocRequest:Promise.resolve(toc)});
  function mount() {
    const reload=vi.fn(),error=vi.fn();
    const hook=renderHook(()=>{const [page,setPage]=useState(seed);return {page,source:useAssetToc(page,setPage,reload,error)};});
    return {...hook,reload,error};
  }
  it('retains current content until a prepared seek is ready and cancels a superseded seek',async()=>{
    const hook=mount();await waitFor(()=>expect(hook.result.current.source).toBeDefined());
    mocks.api.mockResolvedValue({...reply(600),listGeneration:G});
    let release!:(assets:Asset[])=>void;
    const prepare=vi.fn((items:Asset[])=>new Promise<Asset[]>(resolve=>{release=()=>resolve(items);}));
    const first=new AbortController();let pending!:Promise<boolean>;
    act(()=>{pending=hook.result.current.source!.load(600,40,first.signal,prepare);});
    await waitFor(()=>expect(prepare).toHaveBeenCalled());
    expect(hook.result.current.page.items[0].id).toBe('0');expect(hook.result.current.page.items).toHaveLength(40);
    first.abort();await act(async()=>{release([]);await pending;});
    expect(hook.result.current.page.items).toHaveLength(40);
    await act(async()=>{expect(await hook.result.current.source!.load(600,40,new AbortController().signal)).toBe(true);});
    expect(hook.result.current.page.assetRanges!.ranges[1].items[0].id).toBe('600');
  });
  it('requests a first-page/TOC reload on a generation mismatch and retains its viewport data',async()=>{
    const hook=mount();await waitFor(()=>expect(hook.result.current.source).toBeDefined());
    mocks.api.mockResolvedValue({...reply(600),listGeneration:'b'.repeat(64)});
    await act(async()=>{expect(await hook.result.current.source!.load(600,40,new AbortController().signal)).toBe(false);});
    expect(hook.reload).toHaveBeenCalledOnce();expect(hook.result.current.page.items).toHaveLength(40);expect(hook.error).not.toHaveBeenCalled();
  });
  it('keeps current data and uses the inline error callback on a failed page',async()=>{
    const hook=mount();await waitFor(()=>expect(hook.result.current.source).toBeDefined());
    mocks.api.mockRejectedValueOnce(new Error('offline'));
    await act(async()=>{await hook.result.current.source!.load(600,40,new AbortController().signal);});
    expect(hook.error).toHaveBeenCalledWith('offline');expect(hook.result.current.page.items).toHaveLength(40);
  });
  it('refreshes cached bucket semantics without losing loaded ranges',async()=>{
    const cached={...seed(),assetRanges:initial};
    const updated={...toc,utcOffsetMinutes:540,buckets:[{...toc.buckets[0],key:'2026-10'},toc.buckets[1]]};
    const hook=renderHook(()=>{const [page,setPage]=useState({...cached,tocRequest:Promise.resolve(updated)});return useAssetToc(page,setPage,vi.fn(),vi.fn());});
    await waitFor(()=>expect(hook.result.current?.toc.utcOffsetMinutes).toBe(540));
    expect(hook.result.current?.ranges).toBe(initial.ranges);
  });
});
