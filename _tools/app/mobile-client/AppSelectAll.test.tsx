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

const loaded=[{id:'a1',kind:'image'},{id:'a2',kind:'image'}];
const everyId=['a1','a2','a3','a4','a5'];
let hasMore=true,idsReply:unknown;
const generation='a'.repeat(64);
const idsReads=()=>mocks.api.mock.calls.map(([path])=>String(path)).filter(path=>path.includes('ids=1'));
beforeEach(()=>{
  vi.stubGlobal('ResizeObserver',class{observe(){}disconnect(){}});
  localStorage.clear();mocks.api.mockReset();mocks.native.mockReset();hasMore=true;idsReply={listGeneration:generation,totalCount:5,ids:everyId};
  mocks.native.mockImplementation(async(op:string,p:{assetId?:string;assetIds?:string[]})=>{
    if(op==='classificationAssignmentSetMany')return {adopted:true,results:p.assetIds!.map(assetId=>({assetId,ok:true,pending:false,blocked:false,conflictCode:null,message:''}))};
    if(op.startsWith('classificationAssignment'))return {adopted:true,assetId:p.assetId,classificationId:null,classifications:[{id:'game',kind:'root',name:'게임',parentId:null,iconKey:null,colorKey:null}]};
    return {configured:true,endpoint:'https://example.invalid'};
  });
  mocks.api.mockImplementation(async(path:string)=>{
    if(path==='/v1/library/list-generation')return {generation};
    if(path.includes('ids=1'))return idsReply;
    if(path.includes('classifications'))return {items:[{id:'folder',name:'폴더',asset_count:5,parent_id:null}]};
    if(path.includes('revisit'))return {bundles:[]};
    if(path.includes('captures'))return {captures:[]};
    return {items:loaded,has_more:hasMore,next_cursor:hasMore?'next':null,list_generation:generation};
  });
});
afterEach(()=>{cleanup();vi.unstubAllGlobals();vi.restoreAllMocks();});
async function openFolder(){
  render(<App/>);
  fireEvent.click(await screen.findByRole('button',{name:'폴더, 5개'}));
  fireEvent.contextMenu(await screen.findByText('tile-a1'));
  expect(screen.getByText('1개 선택')).toBeTruthy();
}

it('전체 선택 takes every id of the list, including pages not loaded, and batch actions send those ids',async()=>{
  await openFolder();
  fireEvent.click(screen.getByRole('button',{name:'전체 선택'}));
  await screen.findByText('5개 선택');
  expect(idsReads()).toHaveLength(1);
  expect(idsReads()[0]).toContain('classification_id=folder');
  expect(idsReads()[0]).not.toContain('limit=');
  expect(screen.getByRole('button',{name:'전체 선택'}).getAttribute('aria-pressed')).toBe('true');
  fireEvent.click(screen.getByRole('button',{name:'분류 지정'}));
  const sheet=await screen.findByRole('dialog',{name:'분류 변경 (5개)'});
  fireEvent.click(await within(sheet).findByRole('radio',{name:'게임'}));
  fireEvent.click(within(sheet).getByRole('button',{name:'적용'}));
  await within(sheet).findByText('5/5개 분류 변경');
  expect(mocks.native.mock.calls.filter(([op])=>op==='classificationAssignmentSetMany').map(([,p])=>p)).toEqual([{assetIds:everyId,classificationId:'game'}]);
});

it('pressing 전체 선택 again lets go of everything',async()=>{
  await openFolder();
  fireEvent.click(screen.getByRole('button',{name:'전체 선택'}));
  await screen.findByText('5개 선택');
  fireEvent.click(screen.getByRole('button',{name:'전체 선택'}));
  await waitFor(()=>expect(screen.queryByText(/개 선택/)).toBeNull());
});

it('needs no server call when the whole list is already loaded',async()=>{
  hasMore=false;
  await openFolder();
  fireEvent.click(screen.getByRole('button',{name:'전체 선택'}));
  await screen.findByText('2개 선택');
  expect(idsReads()).toHaveLength(0);
  expect(screen.getByRole('button',{name:'전체 선택'}).getAttribute('aria-pressed')).toBe('true');
});

it('falls back to the loaded images and says so when the server cannot list ids yet',async()=>{
  idsReply={items:loaded,has_more:true,next_cursor:'next'};
  await openFolder();
  fireEvent.click(screen.getByRole('button',{name:'전체 선택'}));
  await screen.findByText('2개 선택');
  expect((await screen.findByRole('alert')).textContent).toContain('불러온 2개만 선택했습니다');
  expect(screen.getByRole('button',{name:'전체 선택'}).getAttribute('aria-pressed')).toBe('false');
});

it('drops an id list that arrives after the selection was cleared',async()=>{
  let release!:(value:unknown)=>void;
  mocks.api.mockImplementation(async(path:string)=>{
    if(path.includes('ids=1'))return new Promise(resolve=>{release=resolve;});
    if(path==='/v1/library/list-generation')return {generation};
    if(path.includes('classifications'))return {items:[{id:'folder',name:'폴더',asset_count:5,parent_id:null}]};
    if(path.includes('revisit'))return {bundles:[]};
    if(path.includes('captures'))return {captures:[]};
    return {items:loaded,has_more:true,next_cursor:'next',list_generation:generation};
  });
  await openFolder();
  fireEvent.click(screen.getByRole('button',{name:'전체 선택'}));
  fireEvent.click(screen.getByRole('button',{name:'선택 해제'}));
  await act(async()=>release({listGeneration:generation,totalCount:5,ids:everyId}));
  expect(screen.queryByText(/개 선택/)).toBeNull();
});
