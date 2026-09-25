import type {ReactNode} from 'react';
import {act,cleanup,fireEvent,render,screen,waitFor,within} from '@testing-library/react';
import {afterEach,beforeEach,describe,expect,it,vi} from 'vitest';
const mocks=vi.hoisted(()=>({api:vi.fn(),native:vi.fn()}));
vi.mock('./transport',()=>({api:mocks.api,native:mocks.native,errorText:String,ApiError:class extends Error{status=404;}}));
vi.mock('./media',()=>({clearMediaCache:vi.fn(),loadThumbnail:vi.fn(async(a)=>a)}));
vi.mock('./Gallery',()=>({Gallery:({intro,items,onNearEnd,onOpen,onScroll,restoreScroll,identity,onRefresh}:{intro?:ReactNode;items:{id:string}[];onNearEnd():void;onOpen(i:number):void;onScroll(n:number):void;restoreScroll:number;identity:string;onRefresh():void})=><div className="gallery-scroll" data-identity={identity} data-restore={restoreScroll} onScroll={()=>onScroll(420)}>{intro}{items.map((item,i)=><button key={item.id} onClick={()=>onOpen(i)}>{item.id}</button>)}<button onClick={onNearEnd}>near end</button><button onClick={onRefresh}>refresh</button></div>}));
vi.mock('./Viewer',()=>({Viewer:({items,onClose,onNearEnd}:{items:{id:string}[];onClose():void;onNearEnd():void})=><div data-testid="viewer">{items.map(item=><span key={item.id}>{`viewer:${item.id}`}</span>)}<button onClick={onClose}>viewer close</button><button onClick={onNearEnd}>viewer more</button></div>}));
import {App} from './App';
import {Albums,useAlbumTree} from './Albums';
import {albumPath,albumPage,albumView,type AlbumTree,type NativeAlbum} from './albumModel';
import {pagePath,viewKey} from './model';
const albums:NativeAlbum[]=[{id:'root',name:'업로드용',parentId:null,iconKey:null,colorKey:null,assetCount:5},{id:'child',name:'임시',parentId:'root',iconKey:null,colorKey:null},{id:'other',name:'Other',parentId:null,iconKey:null,colorKey:null}];
const tree:AlbumTree={adopted:true,libraryId:'a'.repeat(32),epoch:1,code:'',albums};
const asset=(id:string)=>({id,kind:'image',preview:'data:image/png;base64,AA'});
const page=(id='a1',more=false)=>({filterVersion:1,items:[asset(id)],hasMore:more,nextCursor:more?'c1':null});
const albumReads=()=>mocks.api.mock.calls.filter(([path])=>String(path).includes('/v1/albums/assets')&&!String(path).includes('limit=3'));
function baseApi(path:string) {
 if(path==='/v1/library/list-generation')return {generation:'b'.repeat(64),filterVersion:1};
 if(path.includes('/v1/albums/assets'))return page(path.includes('albumId=child')?'child-asset':path.includes('albumId=other')?'other-asset':'a1');
 return {items:[],has_more:false,next_cursor:null};
}
async function openRootAlbum(){render(<App/>);fireEvent.click(await screen.findByRole('tab',{name:'앨범'}));fireEvent.click(await screen.findByRole('button',{name:'업로드용, 5개'}));await screen.findByRole('heading',{name:'업로드용'});}
/** Filters live in the folder bar's 보기 옵션 sheet; a chip there opens its own choice sheet. */
async function choose(group='종류',choice='영상'){fireEvent.click(screen.getByRole('button',{name:'보기 옵션'}));fireEvent.click(await screen.findByRole('button',{name:group}));fireEvent.click(screen.getByRole('radio',{name:choice}));}
/** Opens 보기 옵션, reads the filter chip labels, and closes the sheet again. */
async function chipLabels(){fireEvent.click(screen.getByRole('button',{name:'보기 옵션'}));const labels=[...(await screen.findByRole('group',{name:'자산 필터'})).querySelectorAll('button')].map(b=>b.textContent);fireEvent.click(within(screen.getByRole('dialog',{name:'보기 옵션'})).getByRole('button',{name:'닫기'}));await waitFor(()=>expect(screen.queryByRole('dialog',{name:'보기 옵션'})).toBeNull());return labels;}
const chipShown=(label:string)=>waitFor(async()=>expect(await chipLabels()).toContain(label));
function back(){act(()=>window.dispatchEvent(new Event('lakomics-back')));}
beforeEach(()=>{
 localStorage.clear();vi.stubGlobal('ResizeObserver',class{observe(){}disconnect(){}});vi.stubGlobal('matchMedia',()=>({matches:false,addEventListener(){},removeEventListener(){}}));
 mocks.api.mockReset();mocks.native.mockReset();mocks.api.mockImplementation(async(path:string)=>baseApi(path));
 mocks.native.mockImplementation(async(op:string)=>op==='albumTree'?tree:{configured:true,endpoint:'https://example.invalid'});
});
afterEach(()=>{cleanup();vi.unstubAllGlobals();});
describe('album Library scopes',()=>{
 it('renders only top-level cover cards with optional counts and child labels',async()=>{
  render(<Albums tree={tree} paused={false} revision={1} onSelect={()=>{}}/>);
  expect(screen.queryByText('임시')).toBeNull();expect(screen.getByText('하위 앨범 1')).toBeTruthy();
  const cards=document.querySelectorAll('.library-folder-grid .library-folder');expect(cards).toHaveLength(2);
  cards.forEach(card=>expect(card.firstElementChild?.classList.contains('home-cover-group')).toBe(true));
  await waitFor(()=>expect(cards[0].querySelector('img')).not.toBeNull());
  expect(mocks.api.mock.calls.every(([path])=>String(path).includes('limit=3'))).toBe(true);
 });
 it('opens the shared header, gallery, child strip, view options and filter chips without an album dialog',async()=>{
  await openRootAlbum();expect(screen.queryByRole('dialog')).toBeNull();
  expect(screen.getByRole('navigation',{name:'현재 위치'}).textContent).toBe('라이브러리›앨범');
  expect(document.querySelector('.gallery-scroll .library-children .library-folder')?.textContent).toContain('임시');
  // The filters left the content: the gallery starts under the bar, and 보기 옵션 holds them.
  expect(screen.queryByRole('group',{name:'자산 필터'})).toBeNull();
  fireEvent.click(screen.getByRole('button',{name:'보기 옵션'}));expect(screen.getByRole('dialog',{name:'보기 옵션'})).toBeTruthy();
  expect(screen.getByRole('group',{name:'자산 필터'}).textContent).toBe('종류비율길이');back();
  await waitFor(()=>expect(screen.queryByRole('dialog')).toBeNull());expect(screen.getByRole('heading',{name:'업로드용'})).toBeTruthy();
 });
 it('walks inner sheet, filters, parent album, then root with Albums selected',async()=>{
  await openRootAlbum();fireEvent.click(screen.getByRole('button',{name:'임시'}));await screen.findByText('child-asset');
  expect(screen.getByRole('navigation',{name:'현재 위치'}).textContent).toBe('라이브러리›앨범›업로드용');
  await choose();await chipShown('영상');fireEvent.click(screen.getByRole('button',{name:'보기 옵션'}));fireEvent.click(await screen.findByRole('button',{name:'비율'}));
  back();await waitFor(()=>expect(screen.queryByRole('dialog')).toBeNull());await chipShown('영상');
  back();await chipShown('종류');expect(screen.getByRole('heading',{name:'임시'})).toBeTruthy();
  back();await screen.findByRole('heading',{name:'업로드용'});back();await screen.findByRole('heading',{name:'라이브러리'});
  expect(screen.getByRole('tab',{name:'앨범'}).getAttribute('aria-selected')).toBe('true');expect(screen.getByRole('button',{name:'검색'})).toBeTruthy();
 });
 it('jumps through breadcrumbs and restores the parent gallery scroll',async()=>{
  await openRootAlbum();fireEvent.scroll(document.querySelector('.gallery-scroll')!);
  fireEvent.click(screen.getByRole('button',{name:'임시'}));await screen.findByText('child-asset');
  fireEvent.click(within(screen.getByRole('navigation',{name:'현재 위치'})).getByRole('button',{name:'업로드용'}));await screen.findByRole('heading',{name:'업로드용'});
  expect(document.querySelector('.gallery-scroll')?.getAttribute('data-restore')).toBe('420');
  fireEvent.click(within(screen.getByRole('navigation',{name:'현재 위치'})).getByRole('button',{name:'앨범'}));await waitFor(()=>expect(screen.getByRole('tab',{name:'앨범'}).getAttribute('aria-selected')).toBe('true'));await screen.findByRole('heading',{name:'라이브러리'});
 });
 it('uses the album envelope, identity, filter parameters and cursor on the normal append path',async()=>{
  mocks.api.mockImplementation(async(path:string)=>path.includes('/v1/albums/assets')?page(path.includes('cursor=')?'a2':'a1',!path.includes('cursor=')):baseApi(path));
  await openRootAlbum();await choose();await chipShown('영상');
  fireEvent.click(screen.getByRole('button',{name:'near end'}));await screen.findByText('a2');
  const paths=albumReads().map(([path])=>String(path));expect(paths.some(path=>path.includes('cursor=c1')&&path.includes('media_kind=videos'))).toBe(true);
  expect(paths.every(path=>path.includes(`libraryId=${tree.libraryId}`)&&path.includes('epoch=1')&&path.includes('albumId=root'))).toBe(true);
  expect(document.querySelector('.gallery-scroll')?.getAttribute('data-identity')).toContain('media_kind=videos');
 });
 it('keeps failed filters uncommitted, blocks append and retries the attempted query',async()=>{
  let fail=true;
  mocks.api.mockImplementation(async(path:string)=>{if(path.includes('/v1/albums/assets')){if(path.includes('media_kind')){if(fail)throw new Error('narrowing failed');return page('filtered');}return page('a1',true);}return baseApi(path);});
  await openRootAlbum();await choose();await screen.findAllByText(/narrowing failed/);
  expect(screen.getByText('a1')).toBeTruthy();expect(document.querySelector('.gallery-scroll')?.getAttribute('data-identity')).not.toContain('media_kind');
  const reads=albumReads().length;fireEvent.click(screen.getByRole('button',{name:'near end'}));await act(async()=>{});expect(albumReads()).toHaveLength(reads);
  fail=false;fireEvent.click(screen.getAllByRole('button',{name:'다시 시도'})[0]);await screen.findByText('filtered');await chipShown('영상');
 });
 it.each([{}, {filter_version:1}, {filterVersion:2}])('refuses incompatible filtered envelopes %j',async contract=>{
  mocks.api.mockImplementation(async(path:string)=>path.includes('/v1/albums/assets')&&path.includes('media_kind')?{items:[asset('unchecked')],hasMore:false,nextCursor:null,...contract}:baseApi(path));
  await openRootAlbum();await choose();await screen.findAllByText(/서버를 업데이트해 주세요/);expect(screen.queryByText('unchecked')).toBeNull();expect(screen.getByText('a1')).toBeTruthy();
 });
 it('validates every filtered continuation and retains existing rows',async()=>{
  mocks.api.mockImplementation(async(path:string)=>{
   if(path.includes('/v1/albums/assets')&&path.includes('cursor='))return {items:[asset('unchecked')],hasMore:false,nextCursor:null};
   if(path.includes('/v1/albums/assets')&&path.includes('media_kind'))return page('filtered',true);return baseApi(path);
  });
  await openRootAlbum();await choose();await screen.findByText('filtered');fireEvent.click(screen.getByRole('button',{name:'near end'}));await screen.findByText(/서버를 업데이트해 주세요/);
  expect(screen.queryByText('unchecked')).toBeNull();expect(screen.getByText('filtered')).toBeTruthy();
 });
 it('aborts a late continuation when filters change',async()=>{
  let release:(value:unknown)=>void=()=>{};let signal:AbortSignal|undefined;
  mocks.api.mockImplementation((path:string,nextSignal?:AbortSignal)=>{
   if(path.includes('cursor=')){signal=nextSignal;return new Promise(resolve=>{release=resolve;});}
   if(path.includes('/v1/albums/assets'))return Promise.resolve(page(path.includes('media_kind')?'filtered':'a1',!path.includes('media_kind')));return Promise.resolve(baseApi(path));
  });
  await openRootAlbum();fireEvent.click(screen.getByRole('button',{name:'near end'}));await waitFor(()=>expect(signal).toBeDefined());
  await choose();await screen.findByText('filtered');expect(signal?.aborted).toBe(true);await act(async()=>release(page('late')));expect(screen.queryByText('late')).toBeNull();
 });
 it('starts a sibling album unfiltered and separates album cache identities',async()=>{
  await openRootAlbum();await choose();await chipShown('영상');
  fireEvent.click(screen.getByRole('button',{name:'Library',exact:true}));fireEvent.click(await screen.findByRole('button',{name:'Other'}));await screen.findByText('other-asset');
  await chipShown('종류');expect(albumReads().at(-1)?.[0]).not.toContain('media_kind');
  expect(viewKey(albumView(tree,albums[0]))).not.toBe(viewKey(albumView(tree,albums[2])));
  expect(viewKey(albumView(tree,albums[0]))).not.toBe(viewKey(albumView({...tree,epoch:2},albums[0])));
 });
 it('opens the normal viewer, appends there, then refreshes the same album',async()=>{
  mocks.api.mockImplementation(async(path:string)=>path.includes('/v1/albums/assets')?page(path.includes('cursor=')?'a2':'a1',!path.includes('cursor=')):baseApi(path));
  await openRootAlbum();fireEvent.click(screen.getByRole('button',{name:'a1'}));expect(screen.getByTestId('viewer')).toBeTruthy();
  fireEvent.click(screen.getByRole('button',{name:'viewer more'}));await screen.findByText('viewer:a2');back();await waitFor(()=>expect(screen.queryByTestId('viewer')).toBeNull());
  const count=albumReads().length;fireEvent.click(screen.getByRole('button',{name:'refresh'}));await waitFor(()=>expect(albumReads().length).toBeGreaterThan(count));expect(screen.getByRole('heading',{name:'업로드용'})).toBeTruthy();
 });
 it('keeps the root on an authority error and retries the actual album intent',async()=>{
  let fail=true;mocks.api.mockImplementation(async(path:string)=>{if(path.includes('/v1/albums/assets')&&fail)throw new Error('authority unavailable');return baseApi(path);});
  render(<App/>);fireEvent.click(await screen.findByRole('tab',{name:'앨범'}));fireEvent.click(await screen.findByRole('button',{name:'업로드용, 5개'}));await screen.findByText(/authority unavailable/);
  expect(screen.getByRole('heading',{name:'라이브러리'})).toBeTruthy();fail=false;fireEvent.click(screen.getByRole('button',{name:'다시 시도'}));await screen.findByRole('heading',{name:'업로드용'});
 });
 it('bounds malformed hierarchy paths and normalizes only the agreed envelope',()=>{
  const cyclic=[{...albums[0],id:'x',name:'X',parentId:'y'},{...albums[0],id:'y',name:'Y',parentId:'x'}];expect(albumPath(cyclic,'x')).toBe('Y / X');
  expect(albumPage({...page(),items:[asset('a'),asset('a')]})).toEqual({items:[asset('a')],has_more:false,next_cursor:null,filter_version:1});
  expect(pagePath(albumView(tree,albums[0]),'cursor')).toContain('cursor=cursor');
 });
 it('shows no cards when authority is unadopted',()=>{
  const view=render(<Albums tree={{...tree,adopted:false,albums:[]}} paused={false} revision={1} onSelect={()=>{}}/>);expect(view.container.childElementCount).toBe(0);expect(mocks.api).not.toHaveBeenCalled();
 });
});

it('loads at most two visible album covers at a time and aborts on pause',async()=>{
 const observers:{callback:IntersectionObserverCallback;target?:Element}[]=[];
 vi.stubGlobal('IntersectionObserver',class{entry:{callback:IntersectionObserverCallback;target?:Element};constructor(callback:IntersectionObserverCallback){this.entry={callback};observers.push(this.entry);}observe(target:Element){this.entry.target=target;}disconnect(){}});
 const many={...tree,albums:Array.from({length:6},(_,i)=>({...albums[0],id:String(i),name:`Album ${i}`}))};
 const signals:AbortSignal[]=[],release:(()=>void)[]=[];
 mocks.api.mockImplementation((_path,signal)=>new Promise(resolve=>{signals.push(signal);release.push(()=>resolve({...page(),items:[asset('one'),asset('two'),asset('three'),asset('four')]}));}));
 const view=render(<Albums tree={many} paused={false} revision={1} onSelect={()=>{}}/>);expect(mocks.api).not.toHaveBeenCalled();
 act(()=>observers.slice(0,4).forEach(o=>o.callback([{isIntersecting:true,target:o.target}] as IntersectionObserverEntry[],{} as IntersectionObserver)));
 await waitFor(()=>expect(mocks.api).toHaveBeenCalledTimes(2));await act(async()=>release[0]());await waitFor(()=>expect(mocks.api).toHaveBeenCalledTimes(3));
 expect(view.container.querySelector('.home-cover-group')?.querySelectorAll('img')).toHaveLength(3);
 view.rerender(<Albums tree={many} paused revision={1} onSelect={()=>{}}/>);expect(signals.every(signal=>signal.aborted)).toBe(true);
 const reads=mocks.api.mock.calls.length;await act(async()=>release.slice(1).forEach(done=>done()));expect(mocks.api).toHaveBeenCalledTimes(reads);
});
it('reads the native replica on activation, refresh and resume, and cancels stale responses',async()=>{
 const reads:{signal:AbortSignal;resolve:(value:AlbumTree)=>void}[]=[];
 mocks.native.mockImplementation((_op,_args,signal)=>new Promise(resolve=>reads.push({signal,resolve})));
 function Replica({active=true,revision=1}:{active?:boolean;revision?:number}){const {tree,error}=useAlbumTree(active,revision,'endpoint');return <div>{tree?.albums[0]?.name}{error}</div>;}
 const view=render(<Replica active={false}/>);expect(mocks.native).not.toHaveBeenCalled();
 view.rerender(<Replica/>);expect(mocks.native).toHaveBeenCalledWith('albumTree',{},expect.any(AbortSignal));
 act(()=>window.dispatchEvent(new Event('lakomics-resume')));expect(reads[0].signal.aborted).toBe(true);
 await act(async()=>reads[1].resolve(tree));expect(screen.getByText('업로드용')).toBeTruthy();
 await act(async()=>reads[0].resolve({...tree,albums:[{...albums[0],name:'stale'}]}));expect(screen.queryByText('stale')).toBeNull();
 view.rerender(<Replica revision={2}/>);expect(reads).toHaveLength(3);view.rerender(<Replica active={false} revision={2}/>);expect(reads[2].signal.aborted).toBe(true);
});
it('revalidates an album filter response after a generation retry',async()=>{
 let generation='b'.repeat(64),filtered=0;
 mocks.api.mockImplementation(async(path:string)=>{
  if(path==='/v1/library/list-generation')return {generation,filterVersion:1};
  if(path.includes('/v1/albums/assets')&&path.includes('media_kind')){filtered++;generation='c'.repeat(64);return filtered===1?page('first'):{items:[asset('unchecked')],hasMore:false,nextCursor:null};}
  return baseApi(path);
 });
 await openRootAlbum();await choose();await screen.findAllByText(/서버를 업데이트해 주세요/);expect(filtered).toBe(2);expect(screen.queryByText('unchecked')).toBeNull();expect(screen.getByText('a1')).toBeTruthy();
});
