import type {ReactNode} from 'react';
import {act,cleanup,fireEvent,render,renderHook,screen,waitFor} from '@testing-library/react';
import {afterEach,beforeEach,expect,it,vi} from 'vitest';
import type {Asset,View} from './types';
import type {CharacterIndex} from './characterModel';
import {mergeLibraryEntries,ALL_ASSETS,LIBRARY_ROOT} from './libraryModel';
import {announceFolderFilled,tabletRecentCatalog,tabletRecentFolderId,recentFoldersKey,useTabletRecentFolders} from './recentFolders';
const mocks=vi.hoisted(()=>({api:vi.fn(),native:vi.fn()}));
vi.mock('./transport',()=>({api:mocks.api,native:mocks.native,errorText:(reason:unknown)=>reason instanceof Error?reason.message:'connection failed',
  ApiError:class ApiError extends Error{status:number|null;details:unknown;constructor(message:string,status:number|null,details:unknown){super(message);this.status=status;this.details=details;}}}));
vi.mock('./media',()=>({clearMediaCache:vi.fn(),loadThumbnail:vi.fn(async(a)=>a),prepareAssets:()=>new Promise(()=>{})}));
vi.mock('./Home',()=>({Home:()=><div/>}));
vi.mock('./Gallery',()=>({Gallery:({intro,items,onOpen}:{intro?:ReactNode;items:Asset[];onOpen(i:number):void})=><div className="gallery-scroll" aria-label="자산 목록"><div className="gallery-intro">{intro}</div><div>{items.map((a,i)=><button key={a.id} onClick={()=>onOpen(i)}>{`tile-${a.id}`}</button>)}</div></div>}));
vi.mock('./Viewer',()=>({Viewer:({items,index}:{items:Asset[];index:number})=><div>{`viewer-${items[index].id}`}</div>}));
import {App} from './App';

const characters:CharacterIndex={version:1,authority:'pc',authorityEpoch:0,capabilities:{read:true,write:false},ready:true,revision:'a'.repeat(64),publishedAt:null,nodes:[
  {id:'series:s',kind:'series',sourceId:'s',seriesId:'s',parentId:null,name:'블루 아카이브',description:'',thumbnailAssetId:null,manualOnly:false},
  {id:'group:g',kind:'group',sourceId:'g',seriesId:'s',parentId:'series:s',name:'학생회',description:'',thumbnailAssetId:null,manualOnly:false},
  {id:'character:c',kind:'character',sourceId:'c',seriesId:'s',parentId:'group:g',name:'유우카',description:'',thumbnailAssetId:null,manualOnly:false},
  {id:'character:solo',kind:'character',sourceId:'solo',seriesId:'s',parentId:'series:s',name:'호시노',description:'',thumbnailAssetId:null,manualOnly:false},
],scopes:[]};
const items=[{id:'game',name:'게임',parent_id:null,asset_count:20},{id:'s',name:'블루 아카이브',parent_id:'game',asset_count:10},{id:'view',name:'풍경',parent_id:'game',asset_count:3},{id:'other',name:'풍경',parent_id:null,asset_count:2}];
const entries=mergeLibraryEntries(items,characters);
const folder=(classification:string):View=>({tab:'library',classification,title:''});

afterEach(()=>{cleanup();vi.useRealTimers();vi.unstubAllGlobals();localStorage.clear();});

it('names the folder a view is in and ignores places that never count',()=>{
  expect(tabletRecentFolderId(folder('game'),null,entries)).toBe('game');
  for(const view of [LIBRARY_ROOT,ALL_ASSETS,{tab:'library',unclassified:true,title:''},{tab:'library',album:{id:'a',libraryId:'l',epoch:1},title:''},{tab:'home',title:''}] as View[])expect(tabletRecentFolderId(view,null,entries)).toBeNull();
  // The character browser reports its own location; a character inside a group is the group's row.
  const browsing:View={tab:'library',characters:true,characterNode:'series:s',title:''};
  expect(tabletRecentFolderId(browsing,'group:g',entries)).toBe('character-group:g');
  expect(tabletRecentFolderId(browsing,'character:c',entries)).toBe('character-group:g');
  expect(tabletRecentFolderId(browsing,'character:solo',entries)).toBe('character:solo');
  expect(tabletRecentFolderId(browsing,'series:s',entries)).toBe('s');
  expect(tabletRecentFolderId(browsing,null,entries)).toBeNull();
});

it('lists series, groups and loose characters as rows, never the members of a group',()=>{
  const catalog=tabletRecentCatalog(entries);
  expect(catalog.has('character:c')).toBe(false);
  expect(catalog.get('character-group:g')).toMatchObject({name:'학생회',group:true,parentName:'블루 아카이브',path:'게임 › 블루 아카이브 › 학생회'});
  expect(catalog.get('character:solo')).toMatchObject({name:'호시노',group:false,view:{characterNode:'character:solo'}});
  expect(catalog.get('view')).toMatchObject({path:'게임 › 풍경',view:{classification:'view'}});
});

const setup=(over:Partial<Parameters<typeof useTabletRecentFolders>[0]>={})=>{
  const onOpen=vi.fn();
  const hook=renderHook((props:Parameters<typeof useTabletRecentFolders>[0])=>useTabletRecentFolders(props),{initialProps:{scope:'lib',view:folder('game'),focusedNode:null,entries,ready:true,onOpen,...over}});
  return {...hook,onOpen};
};
const names=(result:{current:{folders:{name:string}[]}})=>result.current.folders.map(entry=>entry.name);

it('remembers a folder after three seconds, not while drilling through, and keeps its place when reopened',()=>{
  vi.useFakeTimers();
  const {result,rerender}=setup({view:folder('game')});
  act(()=>vi.advanceTimersByTime(2000));
  rerender({scope:'lib',view:folder('s'),focusedNode:null,entries,ready:true,onOpen:vi.fn()});
  act(()=>vi.advanceTimersByTime(3000));
  expect(names(result)).toEqual(['블루 아카이브']);
  act(()=>result.current.record('game'));
  expect(names(result)).toEqual(['게임','블루 아카이브']);
  act(()=>result.current.open(result.current.folders[1]));
  expect(names(result)).toEqual(['게임','블루 아카이브']);
});

it('records images opened in and filed into a folder, but not from the root',()=>{
  const {result,rerender}=setup({view:folder('s')});
  act(()=>result.current.recordCurrent());
  expect(names(result)).toEqual(['블루 아카이브']);
  act(()=>{announceFolderFilled('game');});
  expect(names(result)).toEqual(['게임','블루 아카이브']);
  act(()=>{announceFolderFilled('missing');});
  rerender({scope:'lib',view:LIBRARY_ROOT,focusedNode:null,entries,ready:true,onOpen:vi.fn()});
  act(()=>result.current.recordCurrent());
  expect(names(result)).toEqual(['게임','블루 아카이브']);
});

it('keeps a history per library, follows renames and drops deleted folders',()=>{
  const {result,rerender}=setup();
  act(()=>{result.current.record('game');result.current.record('s');});
  expect(JSON.parse(localStorage.getItem(recentFoldersKey('lib'))!).map((visit:{id:string})=>visit.id)).toEqual(['s','game']);
  const renamed=mergeLibraryEntries(items.map(item=>item.id==='s'?{...item,name:'새 이름'}:item),characters);
  rerender({scope:'lib',view:folder('game'),focusedNode:null,entries:renamed,ready:true,onOpen:vi.fn()});
  expect(names(result)).toEqual(['새 이름','게임']);
  rerender({scope:'lib',view:folder('game'),focusedNode:null,entries:mergeLibraryEntries(items.filter(item=>item.id!=='game').map(item=>item.id==='s'?{...item,name:'새 이름'}:item),characters),ready:true,onOpen:vi.fn()});
  expect(names(result)).toEqual(['새 이름']);
  rerender({scope:'other-lib',view:folder('game'),focusedNode:null,entries,ready:true,onOpen:vi.fn()});
  expect(names(result)).toEqual([]);
});

const page=(ids:string[])=>({items:ids.map(id=>({id,kind:'image',width:100,height:100})),has_more:false,next_cursor:null,filterVersion:1});
const SCOPE='https://example.invalid';
beforeEach(()=>{
  vi.stubGlobal('ResizeObserver',class{observe(){}disconnect(){}});
  localStorage.clear();mocks.api.mockReset();mocks.native.mockReset();
  mocks.native.mockResolvedValue({configured:true,endpoint:SCOPE});
  mocks.api.mockImplementation(async(path:string)=>{
    if(path==='/v1/library/list-generation')return{generation:'a'.repeat(64),filterVersion:1};
    if(path.startsWith('/v1/library/classifications'))return{items:[{id:'p',name:'부모',asset_count:2,parent_id:null},{id:'q',name:'혼자',asset_count:4,parent_id:null}]};
    if(path.startsWith('/v1/library/assets'))return page(['a1']);
    if(path.includes('revisit'))return{bundles:[]};
    if(path.includes('captures'))return{captures:[]};
    return page(['a1']);
  });
});

it('keeps recording the folder an image was opened in, while the tablet shows no 최근 row',async()=>{
  render(<App/>);
  fireEvent.click(await screen.findByRole('button',{name:'부모, 2개'}));
  fireEvent.click(await screen.findByText('tile-a1'));
  await waitFor(()=>expect(JSON.parse(localStorage.getItem(recentFoldersKey(SCOPE))!).map((visit:{id:string})=>visit.id)).toEqual(['p']));
  expect(screen.queryByText('최근')).toBeNull();
  expect(screen.queryByRole('group',{name:'최근 폴더'})).toBeNull();
});
