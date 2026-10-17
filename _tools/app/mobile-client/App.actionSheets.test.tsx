import type {ReactNode} from 'react';
import {act,cleanup,fireEvent,render,screen,waitFor,within} from '@testing-library/react';
import {afterEach,beforeEach,expect,it,vi} from 'vitest';
import type {Asset} from './types';
const mocks=vi.hoisted(()=>({api:vi.fn(),native:vi.fn()}));
vi.mock('./transport',()=>({api:mocks.api,native:mocks.native,errorText:(e:unknown)=>e instanceof Error?e.message:String(e),ApiError:class ApiError extends Error{status=400;}}));
vi.mock('./media',()=>({clearMediaCache:vi.fn(),loadThumbnail:vi.fn(async(a)=>a),prepareAssets:()=>new Promise(()=>{})}));
vi.mock('./Home',()=>({Home:()=>null}));
vi.mock('./Gallery',()=>({Gallery:({intro,items,onSelectAsset}:{intro?:ReactNode;items:Asset[];onSelectAsset?(id:string):void})=><div aria-label="자산 목록">{intro}{items.map(a=><button key={a.id} onContextMenu={event=>{event.preventDefault();onSelectAsset?.(a.id);}}>{`tile-${a.id}`}</button>)}</div>}));
import {App} from './App';

const authority={libraryId:'a'.repeat(32),epoch:2,contractVersion:1};
const items=[{id:'a1',kind:'image',source_url:'https://x.example/1'},{id:'a2',kind:'image'}];
const folders=[{id:'folder',name:'폴더',asset_count:2,parent_id:null}];
beforeEach(()=>{
  vi.stubGlobal('ResizeObserver',class{observe(){}disconnect(){}});
  vi.stubGlobal('matchMedia',()=>({matches:false,addEventListener(){},removeEventListener(){}}));
  localStorage.clear();mocks.api.mockReset();mocks.native.mockReset();
  mocks.native.mockImplementation(async()=>({configured:true,endpoint:'https://example.invalid'}));
  mocks.api.mockImplementation(async(path:string)=>{
    if(path==='/v1/library/list-generation')return {generation:'a'.repeat(64)};
    if(path.includes('/baseline'))return {libraryId:authority.libraryId,epoch:2,snapshotCursor:9,section:'classifications',items:[{id:'folder',kind:'root',name:'폴더',parentId:null,iconKey:null,colorKey:null,deleted:false,entityRevision:4}],hasMore:false,nextAfter:null};
    if(path.includes('classifications'))return {items:folders,authority};
    if(path.includes('revisit'))return {bundles:[]};
    if(path.includes('captures'))return {captures:[]};
    return {items,has_more:false,next_cursor:null,list_generation:'a'.repeat(64)};
  });
});
afterEach(()=>{cleanup();vi.useRealTimers();vi.unstubAllGlobals();vi.restoreAllMocks();});

it('opens the image menu from the selection bar, closes it with Back before the selection, and offers 정보 열기 for one image only',async()=>{
  render(<App/>);
  fireEvent.click(await screen.findByRole('button',{name:'폴더, 2개'}));
  fireEvent.contextMenu(await screen.findByText('tile-a1'));
  fireEvent.click(screen.getByRole('button',{name:'선택 항목 메뉴'}));
  let sheet=await screen.findByRole('dialog',{name:'1개 선택'});
  expect(within(sheet).getByText('폴더')).toBeTruthy();
  expect(within(sheet).getByRole('button',{name:'출처 복사'}).hasAttribute('disabled')).toBe(false);
  expect(within(sheet).getByRole('button',{name:'정보 열기'})).toBeTruthy();
  act(()=>window.dispatchEvent(new Event('lakomics-back')));
  await waitFor(()=>expect(screen.queryByRole('dialog',{name:'1개 선택'})).toBeNull());
  expect(screen.getByText('1개 선택')).toBeTruthy();
  fireEvent.contextMenu(screen.getByText('tile-a2'));
  fireEvent.click(screen.getByRole('button',{name:'선택 항목 메뉴'}));
  sheet=await screen.findByRole('dialog',{name:'2개 선택'});
  expect(within(sheet).queryByRole('button',{name:'정보 열기'})).toBeNull();
});

it('opens a folder card\'s sheet on a long press and goes straight to the rename form',async()=>{
  render(<App/>);
  const card=await screen.findByRole('button',{name:'폴더, 2개'});
  vi.useFakeTimers({toFake:['setTimeout','clearTimeout']});
  fireEvent.pointerDown(card,{button:0,clientX:30,clientY:30});
  await act(async()=>{vi.advanceTimersByTime(450);});
  fireEvent.pointerUp(card,{button:0});
  vi.useRealTimers();
  const sheet=await screen.findByRole('dialog',{name:'폴더'});
  expect(within(sheet).queryByRole('button',{name:/삭제|이동/})).toBeNull();
  fireEvent.click(within(sheet).getByRole('button',{name:'이름 바꾸기'}));
  const field=await screen.findByLabelText('폴더 이름') as HTMLInputElement;
  expect(field.value).toBe('폴더');
  // The hold did not also open the folder.
  expect(screen.queryByText('tile-a1')).toBeNull();
});
