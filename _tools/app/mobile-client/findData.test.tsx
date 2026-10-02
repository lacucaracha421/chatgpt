import {act,cleanup,renderHook,waitFor} from '@testing-library/react';
import {afterEach,beforeEach,expect,it,vi} from 'vitest';
import {findGroups,matchedSpans} from '../src/shared/findModel';
import {NotesStore,type Note} from '../src/notes/store';
import {tabletFindEntries,useFindWorks,useFindNoteTitles,type FindDestination} from './findData';
import type {CollectionSummary} from './collectionModel';
import type {LibraryArtist} from './artistsModel';
import type {AlbumTree} from './albumModel';
const mocks=vi.hoisted(()=>({api:vi.fn()}));
vi.mock('./transport',()=>({api:mocks.api}));
const work:CollectionSummary={id:'w',name:'별과 바다',originalTitle:'Star Sea',type:'manga',showcase:false};
const artist:LibraryArtist={id:'a',label:'별과 작가',displayName:'별과자리',sourceName:'starsea',keys:['@night'],assetCount:4,recentCount:0,pinned:false,hidden:false,main:true,coverAssetIds:[]};
const note={id:'n',title:'별과 계획',body:'비밀본문',type:'text',deleted:false,concealed:true} as Note;
const albums:AlbumTree={adopted:true,libraryId:'library',epoch:2,code:'',albums:[{id:'album',name:'별과 앨범',parentId:null,colorKey:null,iconKey:null}]};
export function data(navigate:(d:FindDestination)=>void=()=>{}) {
  return tabletFindEntries({works:[{item:work,revision:'r'}],artists:[artist,{...artist,id:'hidden',hidden:true}],notes:[note,{...note,id:'deleted',deleted:true},{...note,id:'month',type:'ledger-month'}],folders:[{id:'folder',name:'별과 폴더',parent_id:null,asset_count:2}],albums,navigate});
}
beforeEach(()=>{mocks.api.mockReset();});
afterEach(cleanup);
it.each([
  ['작품','Star Sea','work-w',{kind:'work',id:'w'}],
  ['작가','@night','artist-a',{kind:'artist',artist}],
  ['메모','ㅂㄱ','note-n',{kind:'note',id:'n'}],
  ['폴더','별과 폴더','place-folder-folder',{kind:'place',view:{tab:'library',classification:'folder',title:'별과 폴더'}}],
  ['폴더','별과 앨범','place-album-album',{kind:'place',view:{tab:'library',title:'별과 앨범',album:{id:'album',libraryId:'library',epoch:2}}}],
  ['화면','카탈','screen-catalog',{kind:'screen',screen:'catalog'}],
] as const)('matches and navigates %s / %s', (scope,query,id,destination)=>{
  const navigate=vi.fn();const groups=findGroups(data(navigate),query,scope,[]);
  const found=groups.flatMap(group=>group.items).find(entry=>entry.id===id)!;
  expect(found).toBeTruthy();found.run();expect(navigate).toHaveBeenCalledWith(destination);
  expect(groups.flatMap(group=>group.items).every(entry=>scope==='폴더'?entry.group==='place':scope==='화면'?entry.group==='go':entry.id.startsWith(scope==='작품'?'work-':scope==='작가'?'artist-':'note-'))).toBe(true);
});
it('finds all kinds together, marks Korean initials, never indexes note bodies or hidden/deleted items',()=>{
  expect(findGroups(data(),'별과','전체',[]).flatMap(group=>group.items)).toHaveLength(5);
  expect(findGroups(data(),'비밀본문','전체',[])).toEqual([]);
  expect(data().some(entry=>entry.id.includes('hidden')||entry.id==='note-deleted'||entry.id==='note-month')).toBe(false);
  expect(matchedSpans('별과 바다','ㅂㄱ')).toContainEqual({text:'별과',matched:true});
  expect(data().find(entry=>entry.id==='note-n')?.keywords).toBeUndefined();
});
it('loads works lazily across all existing collection types and cursor pages; caches until close',async()=>{
  mocks.api.mockImplementation(async(path:string)=>{const q=new URL(path,'https://test').searchParams;return {ready:true,revision:'r',items:[{...work,id:`${q.get('type')}-${q.get('cursor')??'first'}`}],nextCursor:q.get('type')==='manga'&&!q.get('cursor')?'next':null};});
  const hook=renderHook(({open,endpoint})=>useFindWorks(open,endpoint),{initialProps:{open:false,endpoint:'one'}});
  expect(mocks.api).not.toHaveBeenCalled();hook.rerender({open:true,endpoint:'one'});
  await waitFor(()=>expect(hook.result.current.works).toHaveLength(5));expect(mocks.api).toHaveBeenCalledTimes(5);
  hook.rerender({open:true,endpoint:'one'});expect(mocks.api).toHaveBeenCalledTimes(5);
  hook.rerender({open:false,endpoint:'one'});hook.rerender({open:true,endpoint:'two'});
  expect(hook.result.current.works).toEqual([]);await waitFor(()=>expect(hook.result.current.works).toHaveLength(5));
});
it('reports a changed publication or repeated cursor without presenting incomplete works',async()=>{
  mocks.api.mockImplementation(async(path:string)=>({ready:true,revision:path.includes('cursor=')?'new':'old',items:[work],nextCursor:'loop'}));
  const hook=renderHook(()=>useFindWorks(true,'one'));
  await waitFor(()=>expect(hook.result.current.loading).toBe(false));expect(hook.result.current.works).toEqual([]);expect(hook.result.current.error).toBeTruthy();
});
it('uses only unlocked title projections and updates them from the same Notes store without sync/unlock',async()=>{
  const request=vi.fn(async()=>({unlocked:false,notes:[note]}));const store=new NotesStore(request);
  const hook=renderHook(({open})=>useFindNoteTitles(open,store),{initialProps:{open:false}});
  expect(request).not.toHaveBeenCalled();hook.rerender({open:true});await waitFor(()=>expect(hook.result.current.loading).toBe(false));expect(hook.result.current.notes).toEqual([]);
  request.mockResolvedValue({unlocked:true,notes:[note]});await act(()=>store.unlock('test'));
  expect(hook.result.current.notes).toEqual([{id:'n',title:'별과 계획',type:'text',deleted:false}]);
  expect(request.mock.calls.map(call=>call[0])).toEqual(['state','unlock']);
});

it('keeps the previous names during a retry and retains a kind when its refresh fails',async()=>{
  mocks.api.mockResolvedValue({ready:true,revision:'r',items:[work],nextCursor:null});
  const hook=renderHook(()=>useFindWorks(true,'one'));await waitFor(()=>expect(hook.result.current.loading).toBe(false));
  const previous=hook.result.current.works;
  mocks.api.mockRejectedValue(new Error('offline'));act(()=>hook.result.current.retry());
  expect(hook.result.current.works).toEqual(previous);
  await waitFor(()=>expect(hook.result.current.loading).toBe(false));expect(hook.result.current.works).toEqual(previous);expect(hook.result.current.error).toBeTruthy();
});
