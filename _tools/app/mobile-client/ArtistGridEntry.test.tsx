import {useState} from 'react';
import {act, cleanup, fireEvent, render, screen} from '@testing-library/react';
import {afterEach, beforeEach, expect, it, vi} from 'vitest';
import {ArtistGrid} from './ArtistGrid';
import {Artists} from './Artists';
import type {LibraryArtist} from './artistsModel';
import type {Asset} from './types';
import {prepareArtistPage} from './ArtistGridEntry';

const mocks=vi.hoisted(()=>({api:vi.fn(),ready:vi.fn(),gallery:vi.fn()}));
vi.mock('./transport',()=>({api:mocks.api,native:vi.fn(),errorText:(reason:Error)=>reason.message}));
vi.mock('./firstScreen',()=>({readyFirstScreen:mocks.ready}));
vi.mock('./media',()=>({loadThumbnail:async(asset:Asset)=>({...asset,preview:`blob:${asset.id}`})}));
vi.mock('./Gallery',()=>({Gallery:(props:{items:Asset[];intro?:React.ReactNode})=>{
  mocks.gallery(props.items);
  return <div aria-label="자산 목록">{props.intro}{props.items.map(asset=><span key={asset.id}>{asset.id}</span>)}</div>;
}}));

const artist:LibraryArtist={id:'ing',label:'ing',displayName:'ing',sourceName:'ing',keys:[],assetCount:82,recentCount:82,
  firstSavedAt:null,lastSavedAt:null,lastOpenedAt:null,pinned:false,hidden:false,main:true,
  coverAssetIds:Array.from({length:8},(_,index)=>`cover-${index}`)};
const items:Asset[]=Array.from({length:82},(_,index)=>({id:`real-${index}`,kind:index<80?'image':'video',
  width:index%2?600:1200,height:800,collected_at:index<40?'2026-09-28T00:00:00Z':'2026-09-24T00:00:00Z'}));
const wire={items,has_more:false,next_cursor:null,listGeneration:'g1'};
const list={version:1,revision:1,artists:[artist],assignments:[]};
function deferred<T>() {let resolve!:(value:T)=>void;const promise=new Promise<T>(done=>{resolve=done;});return {promise,resolve};}
function Entry() {
  const [selected,setSelected]=useState<LibraryArtist>();
  return selected?<Artists endpoint="test" initialArtist={selected} backRef={{current:null}} onOpenViewer={vi.fn()}/>
    :<ArtistGrid artists={[artist]} state="ready" paused={false} onOpenArtist={setSelected}/>;
}
beforeEach(()=>{
  localStorage.clear();mocks.api.mockReset();mocks.ready.mockReset();mocks.gallery.mockReset();
  mocks.ready.mockImplementation(async(assets:Asset[])=>assets);
  mocks.api.mockImplementation(async(path:string)=>{
    if(path==='/v1/library/artists')return list;
    if(path.startsWith('/v1/library/artists/'))return {artist};
    if(path.includes('toc=1'))return {tocVersion:1,listGeneration:'g1',totalCount:82,sort:'newest',buckets:[{key:'2026-09',count:82,startIndex:0,startCursor:null}]};
    return wire;
  });
});
afterEach(()=>{cleanup();vi.restoreAllMocks();vi.unstubAllGlobals();vi.useRealTimers();});

it('keeps the exact artist list until the real page, TOC and thumbnails are ready, then seeds the first detail render',async()=>{
  const page=deferred<typeof wire>(),toc=deferred<unknown>(),ready=deferred<Asset[]>();
  const original=mocks.api.getMockImplementation()!;
  mocks.api.mockImplementation((path:string)=>path.startsWith('/v1/library/assets?')?(path.includes('toc=1')?toc.promise:page.promise):original(path));
  render(<Entry/>);
  const card=await screen.findByRole('button',{name:'ing, 82장'});
  mocks.ready.mockImplementation(()=>ready.promise);
  fireEvent.click(card);
  expect(screen.getByRole('button',{name:'ing, 82장'})).toBe(card);
  expect(card.closest('[inert]')).toBeTruthy();
  expect(mocks.gallery).not.toHaveBeenCalled();
  await act(async()=>page.resolve(wire));
  await act(async()=>ready.resolve(items.map(asset=>({...asset,preview:`blob:${asset.id}`}))));
  expect(mocks.gallery).not.toHaveBeenCalled();
  await act(async()=>toc.resolve({tocVersion:1,listGeneration:'g1',totalCount:82,sort:'newest',buckets:[{key:'2026-09',count:82,startIndex:0,startCursor:null}]}));
  await screen.findByLabelText('자산 목록');
  expect(mocks.gallery.mock.calls[0][0]).toEqual(items.map(asset=>({...asset,preview:`blob:${asset.id}`})));
  expect(screen.getByRole('button',{name:'이미지 80'})).toBeTruthy();
  expect(screen.getByRole('button',{name:'영상 2'})).toBeTruthy();
  expect(screen.queryByRole('button',{name:'ing, 82장'})).toBeNull();
  expect(mocks.api.mock.calls.filter(([path])=>path.startsWith('/v1/library/assets?'))).toHaveLength(2);
});

it('leaves the list painted after a failed read and allows another tap to retry',async()=>{
  const original=mocks.api.getMockImplementation()!;
  mocks.api.mockImplementation((path:string)=>path.startsWith('/v1/library/assets?')?Promise.reject(new Error('offline')):original(path));
  render(<Entry/>);
  const card=await screen.findByRole('button',{name:'ing, 82장'});
  fireEvent.click(card);
  expect((await screen.findByRole('alert')).textContent).toBe('offline');
  expect(card.closest('[inert]')).toBeNull();
  expect(mocks.gallery).not.toHaveBeenCalled();
  mocks.api.mockImplementation(original);
  fireEvent.click(card);
  await screen.findByLabelText('자산 목록');
});

it('cancels pending navigation when the artist list is paused and ignores a late response',async()=>{
  const page=deferred<typeof wire>();let signal!:AbortSignal;
  mocks.api.mockImplementation((path:string,request:AbortSignal)=>{signal=request;return page.promise;});
  const open=vi.fn();
  const view=render(<ArtistGrid artists={[artist]} state="ready" paused={false} onOpenArtist={open}/>);
  fireEvent.click(await screen.findByRole('button',{name:'ing, 82장'}));
  view.rerender(<ArtistGrid artists={[artist]} state="ready" paused onOpenArtist={open}/>);
  expect(signal.aborted).toBe(true);
  await act(async()=>page.resolve(wire));
  expect(open).not.toHaveBeenCalled();
});

it('holds the standalone artist hub and lets Back cancel before detail commits',async()=>{
  const page=deferred<typeof wire>();const original=mocks.api.getMockImplementation()!;
  mocks.api.mockImplementation((path:string)=>path.startsWith('/v1/library/assets?')?page.promise:original(path));
  const back={current:null as (()=>boolean)|null};
  render(<Artists endpoint="test" backRef={back} onOpenViewer={vi.fn()}/>);
  const card=await screen.findByRole('button',{name:'ing, 82장'});
  fireEvent.click(card);
  expect(card.closest('[inert]')).toBeTruthy();
  act(()=>expect(back.current?.()).toBe(true));
  await act(async()=>page.resolve(wire));
  expect(mocks.gallery).not.toHaveBeenCalled();
  expect(screen.getByRole('button',{name:'ing, 82장'})).toBe(card);
});

it('never renders cover IDs for an unseeded direct entry while its page is pending',async()=>{
  const page=deferred<typeof wire>();const original=mocks.api.getMockImplementation()!;
  mocks.api.mockImplementation((path:string)=>path.startsWith('/v1/library/assets?')?page.promise:original(path));
  render(<Artists endpoint="test" initialArtist={artist} backRef={{current:null}} onOpenViewer={vi.fn()}/>);
  expect(mocks.gallery).not.toHaveBeenCalled();
  await act(async()=>page.resolve(wire));
  await screen.findByLabelText('자산 목록');
  expect(mocks.gallery.mock.calls[0][0]).toEqual(items);
});

it('opens masked detail in privacy mode without reading asset pages or TOCs',async()=>{
  localStorage.setItem('lakomics.mobile.privacyMode','1');
  render(<Entry/>);
  fireEvent.click(await screen.findByRole('button',{name:'ing, 82장'}));
  await screen.findByRole('heading',{level:2,name:'ing'});
  expect(mocks.api.mock.calls.some(([path])=>path.startsWith('/v1/library/assets?'))).toBe(false);
});

it('caps decoding cached first-screen previews at 250 ms and excludes later thumbnails',async()=>{
  vi.useFakeTimers();const decode=vi.fn(()=>new Promise<void>(()=>{}));
  vi.stubGlobal('Image',class {decoding='';src='';decode=decode;});
  const page={...wire,scope:'ing:newest:all',items:items.map(asset=>({...asset,preview:`blob:${asset.id}`}))};
  let committed=false;
  const work=prepareArtistPage(page,new AbortController().signal).then(()=>{committed=true;});
  await vi.advanceTimersByTimeAsync(249);
  expect(committed).toBe(false);
  expect(decode).toHaveBeenCalledTimes(24);
  await vi.advanceTimersByTimeAsync(1);await work;
  expect(committed).toBe(true);
});
