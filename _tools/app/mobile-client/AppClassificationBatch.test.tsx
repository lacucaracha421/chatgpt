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
const items=[{id:'a1',kind:'image'},{id:'a2',kind:'image'}];
let generation='a'.repeat(64);
beforeEach(()=>{
  vi.stubGlobal('ResizeObserver',class{observe(){}disconnect(){}});
  localStorage.clear();mocks.api.mockReset();mocks.native.mockReset();generation='a'.repeat(64);
  mocks.native.mockImplementation(async(op:string,p:{assetId:string;classificationId:string|null})=>{
    if(op.startsWith('classificationAssignment'))return {adopted:true,assetId:p.assetId,classificationId:op==='classificationAssignmentSet'?p.classificationId:null,classifications:[{id:'game',kind:'root',name:'게임',parentId:null,iconKey:null,colorKey:null}]};
    return {configured:true,endpoint:'https://example.invalid'};
  });
  mocks.api.mockImplementation(async(path:string)=>{
    if(path==='/v1/library/list-generation')return {generation};
    if(path.includes('classifications'))return {items:[{id:'folder',name:'폴더',asset_count:2,parent_id:null}]};
    if(path.includes('revisit'))return {bundles:[]};
    if(path.includes('captures'))return {captures:[]};
    return {items,has_more:false,next_cursor:null,list_generation:generation};
  });
});
afterEach(()=>{cleanup();vi.unstubAllGlobals();vi.restoreAllMocks();});
async function selectTwo(){
  render(<App/>);
  fireEvent.click(await screen.findByRole('button',{name:'폴더, 2개'}));
  fireEvent.contextMenu(await screen.findByText('tile-a1'));fireEvent.contextMenu(screen.getByText('tile-a2'));
  expect(screen.getByText('2개 선택')).toBeTruthy();
  fireEvent.click(screen.getByRole('button',{name:'분류 지정'}));
  return await screen.findByRole('dialog',{name:'분류 변경 (2개)'});
}
it('keeps selected tiles and the list DOM until refreshed data arrives after batch assignment',async()=>{
  const sheet=await selectTwo();
  const old=screen.getByText('tile-a1'),gallery=screen.getByLabelText('자산 목록');
  const original=mocks.api.getMockImplementation()!;
  let finish!:(page:unknown)=>void,reads=0;
  const nextPage=new Promise(resolve=>{finish=resolve;});
  mocks.api.mockImplementation((path:string)=>{
    if(path.startsWith('/v1/library/assets?')&&path.includes('classification_id=folder')&&!path.includes('toc=1')){reads++;return nextPage;}
    return original(path);
  });
  generation='b'.repeat(64);
  fireEvent.click(await within(sheet).findByRole('radio',{name:'게임'}));fireEvent.click(within(sheet).getByRole('button',{name:'적용'}));
  await waitFor(()=>expect(reads).toBeGreaterThan(0));
  expect(screen.getByText('tile-a1')).toBe(old);expect(screen.getByLabelText('자산 목록')).toBe(gallery);
  expect(mocks.native.mock.calls.filter(([op])=>op==='classificationAssignmentSet').map(([,p])=>p)).toEqual([{assetId:'a1',classificationId:'game'},{assetId:'a2',classificationId:'game'}]);
  await within(sheet).findByText('2/2개 분류 변경');
  fireEvent.click(within(sheet).getByRole('button',{name:'닫기',exact:true}));
  expect(screen.getByText('2개 선택')).toBeTruthy();
  expect(screen.getByText('2/2개 분류 변경')).toBeTruthy();
  await act(async()=>finish({items:[{id:'updated',kind:'image'}],has_more:false,next_cursor:null,list_generation:generation}));
  await screen.findByText('tile-updated');expect(screen.queryByText('tile-a1')).toBeNull();
  expect(screen.getByLabelText('자산 목록')).toBe(gallery);expect(screen.getByText('2개 선택')).toBeTruthy();
});
it('Back closes the classification sheet before clearing the selection',async()=>{
  await selectTwo();await screen.findByRole('radio',{name:'게임'});
  act(()=>window.dispatchEvent(new Event('lakomics-back')));
  expect(screen.queryByRole('dialog',{name:'분류 변경 (2개)'})).toBeNull();expect(screen.getByText('2개 선택')).toBeTruthy();
});
it('opens a fresh sheet after selection is cleared',async()=>{
  const sheet=await selectTwo();
  fireEvent.click(within(sheet).getByRole('button',{name:'닫기',exact:true}));
  act(()=>window.dispatchEvent(new Event('lakomics-back')));
  expect(screen.queryByText('2개 선택')).toBeNull();
  fireEvent.contextMenu(screen.getByText('tile-a1'));
  fireEvent.click(screen.getByRole('button',{name:'분류 지정'}));
  await screen.findByRole('dialog',{name:'분류 변경 (1개)'});
  expect(screen.queryByRole('dialog',{name:'분류 변경 (2개)'})).toBeNull();
});
