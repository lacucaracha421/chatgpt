import {act,cleanup,fireEvent,render,screen,within} from '@testing-library/react';
import {afterEach,beforeEach,expect,it,vi} from 'vitest';
const mocks=vi.hoisted(()=>({api:vi.fn(),native:vi.fn()}));
vi.mock('./transport',()=>({api:mocks.api,native:mocks.native,errorText:(reason:unknown)=>reason instanceof Error?reason.message:String(reason),ApiError:class extends Error{status=404;}}));
vi.mock('./media',()=>({clearMediaCache:vi.fn(),loadThumbnail:vi.fn(async(asset)=>asset)}));
import {FolderDrawer} from './FolderDrawer';
import {tabletRecentCatalog} from './recentFolders';
import type {Entry} from './libraryModel';
import type {AlbumTree} from './albumModel';

const folder=(id:string,name:string,parent_id:string|null=null,extra:Partial<Entry>={}):Entry=>({id,name,parent_id,asset_count:5,total_asset_count:9,...extra});
// 부모 > 자식 > 손자 and 부모 > 형제 > 조카, beside 혼자 and a character series.
const entries=[folder('p','부모'),folder('c','자식','p'),folder('g','손자','c'),folder('b','형제','p'),folder('n','조카','b'),folder('s','혼자'),folder('x','시리즈',null,{characterNode:'series:x'})];
const albumTree:AlbumTree={adopted:true,libraryId:'a'.repeat(32),epoch:1,code:'',albums:[{id:'a1',name:'여행',parentId:null,iconKey:null,colorKey:null,assetCount:3},{id:'a2',name:'바다',parentId:'a1',iconKey:null,colorKey:null,assetCount:1}]};
const recentOf=(...ids:string[])=>{const catalog=tabletRecentCatalog(entries);return ids.map(id=>catalog.get(id)!);};

beforeEach(()=>{
  vi.stubGlobal('matchMedia',()=>({matches:false,addEventListener(){},removeEventListener(){}}));
  vi.stubGlobal('ResizeObserver',class{observe(){}disconnect(){}});
  mocks.api.mockReset();mocks.native.mockReset();
  mocks.api.mockImplementation(async()=>({items:[],has_more:false,next_cursor:null}));
  mocks.native.mockImplementation(async()=>({}));
});
afterEach(()=>{cleanup();vi.useRealTimers();vi.unstubAllGlobals();});

const handlers=()=>({onClose:vi.fn(),onQuick:vi.fn(),onOpenView:vi.fn(),onOpenRecent:vi.fn(),onRemoveRecent:vi.fn()});
const drawer=(over:Partial<Parameters<typeof FolderDrawer>[0]>={})=>{
  const calls=handlers();
  render(<FolderDrawer entries={entries} currentFolderId="g" quickCurrent={null} pinnedIds={['n']} recent={recentOf('s')} {...calls} {...over}/>);
  return calls;
};
const expanded=(name:string)=>screen.getByRole('button',{name:new RegExp(`^${name} (접기|펼치기)$`)}).getAttribute('aria-expanded');
/** The tree row's name button: pins and recent chips can carry the same name. */
const rowButton=(name:string)=>{
  const found=[...document.querySelectorAll<HTMLElement>('.folder-drawer .tree-select')].filter(button=>button.getAttribute('aria-label')===name);
  expect(found).toHaveLength(1);
  return found[0]!;
};
async function hold(target:HTMLElement){
  vi.useFakeTimers();
  fireEvent.pointerDown(target,{button:0,clientX:40,clientY:40});
  await act(async()=>{vi.advanceTimersByTime(450);});
  fireEvent.pointerUp(target,{button:0});
  vi.useRealTimers();
}

it('lists 빠른 보기, 고정, 최근 and 폴더 in that order, with the current folder marked',()=>{
  drawer({quickCurrent:'all'});
  const labels=screen.getAllByText(/^(빠른 보기|고정|최근|폴더)$/).filter(node=>!node.closest('nav')).map(node=>node.textContent);
  expect(labels).toEqual(['빠른 보기','고정','최근','폴더']);
  expect(within(screen.getByRole('navigation',{name:'빠른 보기'})).getAllByRole('button').map(button=>button.textContent)).toEqual(['모든 에셋','앨범','작가']);
  expect(screen.getByRole('button',{name:'모든 에셋'}).getAttribute('aria-current')).toBe('page');
  expect(rowButton('손자').getAttribute('aria-current')).toBe('page');
  expect(within(screen.getByRole('group',{name:'고정한 폴더'})).getByRole('button',{name:'조카'})).toBeTruthy();
  expect(within(screen.getByRole('group',{name:'최근 폴더'})).getByRole('button',{name:/혼자/})).toBeTruthy();
});

it('opens only the current folder path, and opening a branch shuts its open siblings',()=>{
  drawer();
  expect(expanded('부모')).toBe('true');
  expect(expanded('자식')).toBe('true');
  expect(expanded('형제')).toBe('false');
  fireEvent.click(screen.getByRole('button',{name:'형제 펼치기'}));
  expect(expanded('형제')).toBe('true');
  expect(expanded('자식')).toBe('false');
  // Shutting the parent shuts what is inside it.
  fireEvent.click(screen.getByRole('button',{name:'부모 접기'}));
  expect(expanded('부모')).toBe('false');
  fireEvent.click(screen.getByRole('button',{name:'부모 펼치기'}));
  expect(expanded('부모')).toBe('true');
  expect(expanded('형제')).toBe('false');
});

it('opens a place with a tap on a row, a pin, a recent chip or a quick view',()=>{
  const calls=drawer();
  fireEvent.click(rowButton('혼자'));
  expect(calls.onOpenView).toHaveBeenLastCalledWith(expect.objectContaining({classification:'s'}));
  fireEvent.click(within(screen.getByRole('group',{name:'고정한 폴더'})).getByRole('button',{name:'조카'}));
  expect(calls.onOpenView).toHaveBeenLastCalledWith(expect.objectContaining({classification:'n'}));
  fireEvent.click(within(screen.getByRole('group',{name:'최근 폴더'})).getByRole('button'));
  expect(calls.onOpenRecent).toHaveBeenCalledWith(expect.objectContaining({id:'s'}));
  fireEvent.click(screen.getByRole('button',{name:'앨범'}));
  expect(calls.onQuick).toHaveBeenCalledWith('albums');
});

it('opens a plain folder sheet on a long press and gives character series none',async()=>{
  const onFolderActions=vi.fn();
  drawer({onFolderActions});
  await hold(rowButton('손자'));
  expect(onFolderActions).toHaveBeenCalledWith(expect.objectContaining({id:'g'}));
  await hold(rowButton('시리즈'));
  expect(onFolderActions).toHaveBeenCalledOnce();
});

it('removes a recent folder from its long-press sheet',async()=>{
  const calls=drawer();
  await hold(within(screen.getByRole('group',{name:'최근 폴더'})).getByRole('button'));
  fireEvent.click(within(await screen.findByRole('dialog',{name:'혼자'})).getByRole('button',{name:'최근에서 빼기'}));
  expect(calls.onRemoveRecent).toHaveBeenCalledWith('s');
});

it('closes with Back, and an open sheet takes Back first',async()=>{
  const calls=drawer();
  await hold(within(screen.getByRole('group',{name:'최근 폴더'})).getByRole('button'));
  await screen.findByRole('dialog',{name:'혼자'});
  act(()=>{window.dispatchEvent(new Event('lakomics-back'));});
  expect(calls.onClose).not.toHaveBeenCalled();
  expect(screen.queryByRole('dialog',{name:'혼자'})).toBeNull();
  act(()=>{window.dispatchEvent(new Event('lakomics-back'));});
  expect(calls.onClose).toHaveBeenCalledOnce();
});
