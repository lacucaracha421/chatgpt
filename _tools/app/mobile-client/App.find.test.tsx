import {act,cleanup,fireEvent,render,screen,waitFor,within} from '@testing-library/react';
import {afterEach,beforeEach,expect,it,vi} from 'vitest';
import type {MutableRefObject} from 'react';
import type {CollectionsRequest} from './Collections';
import type {LibraryArtist} from './artistsModel';
import type {Asset} from './types';
const mocks=vi.hoisted(()=>({api:vi.fn(),native:vi.fn()}));
vi.mock('./transport',()=>({api:mocks.api,native:mocks.native,errorText:()=> 'failed'}));
vi.mock('./media',()=>({clearMediaCache:vi.fn(),loadThumbnail:vi.fn(async a=>a),prepareAssets:()=>new Promise(()=>{}),mediaTicket:vi.fn(async()=>({url:'https://test/cover'}))}));
vi.mock('./Home',()=>({Home:()=> <div aria-label="home-content"/>}));
vi.mock('./Gallery',()=>({Gallery:({items}:{items:Asset[]})=><div aria-label="gallery-content">{items.map(item=><span key={item.id}>{item.id}</span>)}</div>}));
vi.mock('./Collections',()=>({Collections:({active,request,backRef}:{active:boolean;request:CollectionsRequest|null;backRef:MutableRefObject<(()=>boolean)|null>})=>{backRef.current=()=>false;return active?<section aria-label="collections-screen">{request?.kind==='work'?request.id:'root'}</section>:null;}}));
vi.mock('./Notes',()=>({Notes:({active,request,backRef}:{active:boolean;request:{id:string}|null;backRef:MutableRefObject<(()=>boolean)|null>})=>{backRef.current=()=>false;return active?<section aria-label="notes-screen">{request?.id??'root'}</section>:null;}}));
vi.mock('./Artists',()=>({
  Artists:({initialArtist}:{initialArtist?:LibraryArtist})=><section aria-label="artist-screen">{initialArtist?.id}</section>,
  HiddenArtists:()=>null,ArtistImage:()=>null,EmptyArtists:()=>null,
}));
vi.mock('./Settings',()=>({Settings:()=> <section aria-label="settings-screen"/>}));
vi.mock('./Catalog',()=>({Catalog:({active}:{active:boolean})=>active?<section aria-label="catalog-screen"/>:null}));
import {App} from './App';
const back=()=>act(()=>{window.dispatchEvent(new Event('lakomics-back'));});
const nav=(label:string)=>within(screen.getByRole('navigation',{name:'주요 탐색'})).getByRole('button',{name:label,exact:true});
beforeEach(()=>{
  localStorage.clear();mocks.api.mockReset();mocks.native.mockReset();
  vi.stubGlobal('ResizeObserver',class {observe(){}disconnect(){}});
  window.LakomicsNative={localStatus:()=>JSON.stringify({configured:true,endpoint:'https://test'})};
  mocks.native.mockImplementation(async(op:string)=>{
    if(op==='notesState')return {unlocked:true,notes:[{id:'note-id',title:'별과 메모',body:'body-secret',pinned:false,deleted:false,createdAt:'2026-10-02',updatedAt:'2026-10-02',localRevision:1,pending:false,conflict:false}]};
    if(op==='albumTree')return {adopted:true,libraryId:'lib',epoch:2,albums:[{id:'album-id',name:'별과 앨범',parentId:null}]};
    return {configured:true,endpoint:'https://test'};
  });
  mocks.api.mockImplementation(async(path:string)=>{
    if(path.startsWith('/v1/collections?')){const q=new URL(path,'https://test').searchParams;return {ready:true,revision:'r',items:q.get('type')==='manga'?[{id:'work-id',name:'별과 작품',type:'manga',showcase:false}]:[],nextCursor:null};}
    if(path==='/v1/library/artists')return {artists:[{id:'artist-id',label:'별과 작가',keys:[],coverAssetIds:[],assetCount:1}]};
    if(path.includes('classifications'))return {items:[{id:'folder-id',name:'별과 폴더',parent_id:null,asset_count:1}]};
    if(path.includes('characters'))return {ready:false,nodes:[],scopes:[]};
    if(path.includes('revisit'))return {bundles:[]};if(path.includes('captures'))return {captures:[]};
    if(path.includes('list-generation'))return {generation:'a'.repeat(64)};
    if(path.startsWith('/v1/albums/'))return {items:[{id:'album-image',kind:'image'}],hasMore:false,nextCursor:null};
    return {items:[{id:path.includes('classification_id=folder-id')?'folder-image':'home-image',kind:'image'}],has_more:false,next_cursor:null};
  });
});
afterEach(()=>{cleanup();vi.unstubAllGlobals();delete window.LakomicsNative;});
async function start(query:string){render(<App/>);fireEvent.click(await screen.findByRole('button',{name:'찾기',exact:true}));const input=await screen.findByRole('combobox');fireEvent.change(input,{target:{value:query}});return input;}
it.each([
  ['별과 작품','collections-screen','work-id'],['별과 작가','artist-screen','artist-id'],['별과 메모','notes-screen','note-id'],
  ['별과 폴더','gallery-content','folder-image'],['별과 앨범','gallery-content','album-image'],
  ['설정','settings-screen',''],['컬렉션','collections-screen','root'],['메모','notes-screen','root'],['카탈로그','catalog-screen',''],
])('a find pick %s uses the tablet destination and closes the sheet',async(query,region,text)=>{
  await start(query);const options=await screen.findAllByRole('option');
  fireEvent.click(options.find(option=>option.textContent?.startsWith(query))!);
  await waitFor(()=>expect(screen.queryByRole('dialog',{name:'찾기'})).toBeNull());
  expect((await screen.findByLabelText(region)).textContent).toContain(text);
});
it('Android Back closes find first, preserves Home, then the usual back chain works',async()=>{
  await start('별과');await screen.findAllByRole('option');back();
  await waitFor(()=>expect(screen.queryByRole('dialog',{name:'찾기'})).toBeNull());
  expect(nav('홈').getAttribute('aria-current')).toBe('page');expect(mocks.native.mock.calls.some(([op])=>op==='finish')).toBe(false);
});
it('keeps the existing Assets search in its top-bar slot',async()=>{
  render(<App/>);fireEvent.click(nav('에셋'));await screen.findByRole('heading',{name:'에셋'});
  expect(screen.getByRole('button',{name:'검색',exact:true})).toBeTruthy();expect(screen.queryByRole('button',{name:'찾기',exact:true})).toBeNull();
});

it.each(['홈','에셋'])('find opens the %s tab',async(name)=>{
  await start(name);fireEvent.click(await screen.findByRole('option'));
  await waitFor(()=>expect(nav(name).getAttribute('aria-current')).toBe('page'));
  expect(screen.queryByRole('dialog',{name:'찾기'})).toBeNull();
});
