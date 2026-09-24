import type {ReactNode} from 'react';
import {act,cleanup,fireEvent,render,screen,waitFor} from '@testing-library/react';
import {afterEach,beforeEach,describe,expect,it,vi} from 'vitest';
import type {Asset} from './types';
const mocks=vi.hoisted(()=>({api:vi.fn(),native:vi.fn(),mediaTicket:vi.fn()}));
vi.mock('./transport',()=>({api:mocks.api,native:mocks.native,errorText:String,ApiError:class extends Error{status=404;}}));
vi.mock('./media',()=>({clearMediaCache:vi.fn(),loadThumbnail:vi.fn(async(a:Asset)=>a),mediaTicket:mocks.mediaTicket}));
vi.mock('./Gallery',()=>({Gallery:({intro,items}:{intro?:ReactNode;items:{id:string}[]})=><div className="gallery-scroll">{intro}{items.map(item=><span key={item.id}>{item.id}</span>)}</div>}));
import {App} from './App';
import {FaultGame,loadFaultPhotos} from './FaultGame';
import {connectFaultFrame,faultCandidates,faultGameUrl,photosMessage,pickRandom,readGameEvent,type FaultPhoto} from '../src/games/fault/host';
import type {AlbumTree} from './albumModel';

const image=(id:string,extra:Partial<Asset>={}):Asset=>({id,kind:'image',content_type:'image/jpeg',size_bytes:1000,...extra});
const origin=window.location.origin;
/** A stand-in host window whose `message` listeners the test can drive with forged sources. */
function fakeHost() {
  const listeners=new Set<(e:MessageEvent)=>void>();
  return {listeners,host:{location:{origin},addEventListener:(_:string,f:(e:MessageEvent)=>void)=>listeners.add(f),removeEventListener:(_:string,f:(e:MessageEvent)=>void)=>listeners.delete(f)} as unknown as Window,
    emit:(source:unknown,data:unknown,from=origin)=>listeners.forEach(f=>f({source,origin:from,data} as MessageEvent))};
}
beforeEach(()=>{
  localStorage.clear();vi.stubGlobal('ResizeObserver',class{observe(){}disconnect(){}});vi.stubGlobal('matchMedia',()=>({matches:false,addEventListener(){},removeEventListener(){}}));
  mocks.api.mockReset();mocks.native.mockReset();mocks.mediaTicket.mockReset();
  mocks.mediaTicket.mockImplementation(async(asset:Asset)=>({url:`https://app.lakomics.local/media-cache/1/${asset.id}?mime=image%2Fjpeg`}));
});
afterEach(()=>{cleanup();vi.unstubAllGlobals();});

describe('FAULT host helper',()=>{
  it('keeps only stored still images the game can convert',()=>{
    const items=[image('a'),image('v',{kind:'video',content_type:'video/mp4'}),image('p',{pending:true}),image('h',{content_type:'image/heic'}),image('big',{size_bytes:21*1024*1024}),image('untyped',{content_type:undefined,size_bytes:undefined})];
    expect(faultCandidates(items).map(item=>item.id)).toEqual(['a','untyped']);
  });
  it('draws 24 distinct items at random from a larger scope and all of a smaller one',()=>{
    const many=Array.from({length:40},(_,i)=>i);
    const first=pickRandom(many),second=pickRandom(many,24,()=>0);
    expect(first).toHaveLength(24);expect(new Set(first).size).toBe(24);
    expect(second).toEqual(many.slice(0,24));expect(pickRandom(many,24,()=>0.999)[0]).toBe(39);
    expect(pickRandom([1,2,3],24,()=>0).sort()).toEqual([1,2,3]);
    expect(pickRandom([])).toEqual([]);
  });
  it('shapes the v1 photos message and refuses empty or oversized sets',()=>{
    const blob=new Blob(['x'],{type:'image/jpeg'});
    expect(photosMessage([{id:'a',blob}])).toEqual({type:'lakomics-fault-photos',version:1,photos:[{id:'a',blob}]});
    expect(()=>photosMessage([])).toThrow(RangeError);
    expect(()=>photosMessage(Array.from({length:25},(_,i)=>({id:String(i),blob})))).toThrow(RangeError);
    expect(faultGameUrl()).toMatch(/fault.*\.html#host=lakomics$/);
  });
  it('accepts game events only from the embedded window on this origin',()=>{
    const game={} as Window;
    const event=(source:unknown,data:unknown,from=origin)=>({source,origin:from,data}) as MessageEvent;
    expect(readGameEvent(event(game,{type:'lakomics-fault-ready'}),game,origin)).toBe('lakomics-fault-ready');
    expect(readGameEvent(event(game,{type:'lakomics-fault-close'}),game,origin)).toBe('lakomics-fault-close');
    expect(readGameEvent(event({},{type:'lakomics-fault-close'}),game,origin)).toBeNull();
    expect(readGameEvent(event(game,{type:'lakomics-fault-close'},'https://evil.example'),game,origin)).toBeNull();
    expect(readGameEvent(event(game,{type:'other'}),game,origin)).toBeNull();
    expect(readGameEvent(event(game,null),game,origin)).toBeNull();
  });
  it('posts the photos once after both readiness and loading, and relays close',()=>{
    const {host,emit,listeners}=fakeHost(),game={postMessage:vi.fn()},onClose=vi.fn();
    const link=connectFaultFrame({game:()=>game as unknown as Window,onClose,host});
    const photos:FaultPhoto[]=[{id:'a',blob:new Blob(['x'],{type:'image/png'})}];
    link.supply(photos);expect(game.postMessage).not.toHaveBeenCalled();
    emit({}, {type:'lakomics-fault-ready'});expect(game.postMessage).not.toHaveBeenCalled();
    emit(game,{type:'lakomics-fault-ready'});
    expect(game.postMessage).toHaveBeenCalledWith(photosMessage(photos),origin);
    emit(game,{type:'lakomics-fault-ready'});link.supply(photos);expect(game.postMessage).toHaveBeenCalledTimes(1);
    emit(game,{type:'lakomics-fault-close'},'https://evil.example');expect(onClose).not.toHaveBeenCalled();
    emit(game,{type:'lakomics-fault-close'});expect(onClose).toHaveBeenCalledTimes(1);
    link.dispose();expect(listeners.size).toBe(0);
  });
  it('also sends when the game is ready before the photos, and never after dispose',()=>{
    const {host,emit}=fakeHost(),game={postMessage:vi.fn()};
    const early=connectFaultFrame({game:()=>game as unknown as Window,onClose:vi.fn(),host});
    emit(game,{type:'lakomics-fault-ready'});early.supply([{id:'a',url:'blob:x'}]);
    expect(game.postMessage).toHaveBeenCalledTimes(1);early.dispose();
    const late=connectFaultFrame({game:()=>game as unknown as Window,onClose:vi.fn(),host});
    late.dispose();emit(game,{type:'lakomics-fault-ready'});late.supply([{id:'a',url:'blob:x'}]);
    expect(game.postMessage).toHaveBeenCalledTimes(1);
  });
});

describe('FAULT photo loading',()=>{
  it('reads original media for at most 24 images, skipping unreadable ones and typing bare bodies',async()=>{
    const bytes=()=>new Uint8Array([1,2]);
    const fetch=vi.fn(async(url:string)=>url.includes('/bad')?new Response('',{status:404}):url.includes('/bare')?new Response(bytes()):new Response(bytes(),{headers:{'content-type':'image/jpeg'}}));
    vi.stubGlobal('fetch',fetch);
    const items=[image('bad'),image('bare',{content_type:'image/png'}),image('video',{kind:'video'}),...Array.from({length:30},(_,i)=>image(`ok${i}`))];
    const photos=await loadFaultPhotos(items,undefined,undefined,()=>0);
    expect(mocks.mediaTicket).toHaveBeenCalledTimes(24);
    expect(mocks.mediaTicket.mock.calls.every(([,variant])=>variant==='original')).toBe(true);
    expect(photos).toHaveLength(23);expect(photos.every(photo=>!!photo.blob?.size&&!!photo.blob.type)).toBe(true);
    expect(photos.some(photo=>photo.id==='bad')).toBe(false);
    const all=await loadFaultPhotos([image('bad'),image('bare',{content_type:'image/png'})],undefined,undefined,()=>0);
    expect(all).toHaveLength(1);expect(all[0].id).toBe('bare');expect(all[0].blob?.type).toBe('image/png');
  });
  it('shows the loading state, hands over photos when the game is ready, and closes from the game',async()=>{
    vi.stubGlobal('fetch',vi.fn(async()=>new Response(new Uint8Array([1,2]),{headers:{'content-type':'image/jpeg'}})));
    const onClose=vi.fn();render(<FaultGame items={[image('a')]} onClose={onClose}/>);
    const frame=screen.getByTitle('FAULT — REVEAL') as HTMLIFrameElement;
    expect(frame.getAttribute('src')).toMatch(/#host=lakomics$/);expect(screen.getByRole('status').textContent).toMatch(/사진 불러오는 중 \d \/ 1|사진을 준비하고 있습니다/);
    const post=vi.spyOn(frame.contentWindow!,'postMessage').mockImplementation(()=>{});
    act(()=>{window.dispatchEvent(new MessageEvent('message',{data:{type:'lakomics-fault-ready'},origin,source:frame.contentWindow}));});
    await waitFor(()=>expect(post).toHaveBeenCalledTimes(1));
    expect(post.mock.calls[0][0]).toMatchObject({type:'lakomics-fault-photos',version:1,photos:[{id:'a'}]});
    // The cover stays until the game reports the photos are converted and on screen.
    await waitFor(()=>expect(screen.getByRole('status').textContent).toContain('게임에 사진을 넣고 있습니다'));
    act(()=>{window.dispatchEvent(new MessageEvent('message',{data:{type:'lakomics-fault-loaded',count:1},origin,source:frame.contentWindow}));});
    await waitFor(()=>expect(screen.queryByRole('status')).toBeNull());
    act(()=>{window.dispatchEvent(new MessageEvent('message',{data:{type:'lakomics-fault-close'},origin,source:frame.contentWindow}));});
    expect(onClose).toHaveBeenCalledTimes(1);
  });
  it('reports a scope where no image could be read and still offers 닫기',async()=>{
    vi.stubGlobal('fetch',vi.fn(async()=>new Response('',{status:500})));
    const onClose=vi.fn();render(<FaultGame items={[image('a')]} onClose={onClose}/>);
    expect((await screen.findByRole('alert')).textContent).toContain('사진을 불러오지 못했습니다');
    fireEvent.click(screen.getByRole('button',{name:'닫기'}));expect(onClose).toHaveBeenCalled();
  });
});

describe('FAULT entry',()=>{
  const tree:AlbumTree={adopted:true,libraryId:'a'.repeat(32),epoch:1,code:'',albums:[{id:'root',name:'업로드용',parentId:null,iconKey:null,colorKey:null,assetCount:2}]};
  function serve(items:Asset[]) {
    mocks.native.mockImplementation(async(op:string)=>op==='albumTree'?tree:{configured:true,endpoint:'https://example.invalid'});
    mocks.api.mockImplementation(async(path:string)=>path==='/v1/library/list-generation'?{generation:'b'.repeat(64),filterVersion:1}:path.includes('/v1/albums/assets')?{filterVersion:1,items,hasMore:false,nextCursor:null}:{items:[],has_more:false,next_cursor:null});
  }
  async function openAlbumOptions(){
    render(<App/>);fireEvent.click(await screen.findByRole('tab',{name:'앨범'}));fireEvent.click(await screen.findByRole('button',{name:'업로드용, 2개'}));
    await screen.findByRole('heading',{name:'업로드용'});fireEvent.click(screen.getByRole('button',{name:'보기 옵션'}));
  }
  it('offers FAULT in an album with images, opens the game over the app and closes it with Back',async()=>{
    vi.stubGlobal('fetch',vi.fn(()=>new Promise(()=>{})));
    serve([image('a1'),image('v1',{kind:'video'})]);await openAlbumOptions();
    fireEvent.click(screen.getByRole('button',{name:'FAULT로 플레이'}));
    expect(await screen.findByRole('dialog',{name:'FAULT'})).toBeTruthy();expect(screen.queryByRole('dialog',{name:'보기 옵션'})).toBeNull();
    expect(mocks.mediaTicket).toHaveBeenCalledWith(expect.objectContaining({id:'a1'}),'original',expect.anything());
    expect(mocks.mediaTicket).toHaveBeenCalledTimes(1);
    act(()=>window.dispatchEvent(new Event('lakomics-back')));
    await waitFor(()=>expect(screen.queryByRole('dialog',{name:'FAULT'})).toBeNull());
    expect(screen.getByRole('heading',{name:'업로드용'})).toBeTruthy();
  });
  it('hides FAULT when the album holds no images',async()=>{
    serve([image('v1',{kind:'video'})]);await openAlbumOptions();
    expect(screen.getByRole('dialog',{name:'보기 옵션'})).toBeTruthy();expect(screen.queryByRole('button',{name:'FAULT로 플레이'})).toBeNull();
  });
});
