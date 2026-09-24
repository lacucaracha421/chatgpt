import {act,cleanup,fireEvent,render,screen,waitFor} from '@testing-library/react';
import {useState} from 'react';
import {afterEach,beforeEach,describe,expect,it,vi} from 'vitest';
const mocks=vi.hoisted(()=>({native:vi.fn(),api:vi.fn()}));
vi.mock('./transport',()=>({native:mocks.native,api:mocks.api,errorText:(e:unknown)=>e instanceof Error?e.message:String(e)}));
vi.mock('./media',()=>({mediaTicket:vi.fn(()=>Promise.resolve({url:'https://thumb.example/pending'}))}));
import {LibraryTrash} from './LibraryTrash';
import {useLibraryTrash} from './useLibraryTrash';
import {formatBytes,pendingTrashIds,trashTiles,type LifecycleState,type TrashItem} from './libraryTrash';
import type {Asset} from './types';

const LIB='e'.repeat(32);
const item=(id:string,revision=2,trashedAt='2026-09-24T03:00:00Z'):TrashItem=>({id,kind:'image',size_bytes:1024,lifecycle:'trash',entityRevision:revision,trashedAt,thumbnail_available:true});
const state=(items:LifecycleState['items']=[],extra:Partial<LifecycleState>={}):LifecycleState=>({available:true,code:'',items,...extra});
const row=(assetId:string,command:'trash'|'restore',rowState:'pending'|'sending'|'blocked'|'dropped'='pending')=>({assetId,command,state:rowState,conflictCode:rowState==='blocked'?'revisionConflict':rowState==='dropped'?'assetTombstoned':null,createdAt:'2026-09-24T05:00:00Z'});

afterEach(()=>{cleanup();vi.useRealTimers();});
beforeEach(()=>{mocks.native.mockReset();mocks.api.mockReset();});

describe('Library Trash model',()=>{
  it('composes local intents and server rows into labelled tiles',()=>{
    const tiles=trashTiles([item('a'),item('b'),item('c')],state([row('p','trash','sending'),row('a','restore'),row('b','restore','blocked'),row('gone','trash','dropped')]),new Map([['p',{id:'p',kind:'video'}]]));
    expect(tiles.map(tile=>[tile.id,tile.status])).toEqual([['gone','deleted'],['p','moving'],['a','restoring'],['b','conflict'],['c','trash']]);
    expect(tiles.find(tile=>tile.id==='p')?.asset.kind).toBe('video');
    expect(tiles.find(tile=>tile.id==='a')?.entityRevision).toBe(2);
  });
  it('hides only trash intents the server has not accepted',()=>{
    expect(pendingTrashIds(state([row('a','trash'),row('b','trash','sending'),row('c','trash','blocked'),row('d','restore')]))).toEqual(['a','b']);
  });
  it('formats sizes',()=>{
    expect(formatBytes(0)).toBe('0 B');expect(formatBytes(1536)).toBe('1.5 KB');expect(formatBytes(5*1024*1024*1024)).toBe('5.0 GB');
  });
});

describe('Library Trash browser',()=>{
  const page={active:true,items:[item('a',4),item('b',2,'2026-09-20T00:00:00Z')],next_cursor:null,has_more:false,total_count:2,total_bytes:3*1024*1024};
  const mount=()=>render(<LibraryTrash backRef={{current:null}} known={new Map()} onClose={()=>{}}/>);
  beforeEach(()=>{
    mocks.api.mockImplementation((path:string)=>path.startsWith('/v1/library/trash')?Promise.resolve(page)
      :Promise.resolve({items:[{asset_id:'a',ok:true,url:'https://thumb.example/a'},{asset_id:'b',ok:true,url:'javascript:alert(1)'}]}));
    mocks.native.mockImplementation((op:string)=>Promise.resolve(op==='assetLifecycleState'?state([row('p','trash')]):state([row('p','trash'),row('a','restore')])));
  });

  it('shows count, size, the PC-only emptying hint and no empty action',async()=>{
    mount();
    expect(await screen.findByText('2개 · 3.0 MB · 이동 대기 1')).toBeTruthy();
    expect(screen.getByText(/비우기는 PC에서/)).toBeTruthy();
    expect(screen.queryByRole('button',{name:/비우기|영구 삭제/})).toBeNull();
    expect(screen.getByRole('button',{name:/이동 대기/})).toBeTruthy();
    // Trash thumbnails use the trash-scoped ticket batch, and only https URLs are used.
    await waitFor(()=>expect(mocks.api).toHaveBeenCalledWith('/v1/library/media-tickets?lifecycle=trash',undefined,{items:[{asset_id:'a',variant:'thumbnail'},{asset_id:'b',variant:'thumbnail'}]},'POST'));
    await waitFor(()=>expect(document.querySelector('img[src="https://thumb.example/a"]')).toBeTruthy());
    expect(document.querySelector('img[src^="javascript"]')).toBeNull();
  });

  it('restores one selected item with the revision it saw, then shows 복원 대기',async()=>{
    const restored=vi.fn();
    render(<LibraryTrash backRef={{current:null}} known={new Map()} onClose={()=>{}} onRestored={restored}/>);
    const tiles=await screen.findAllByRole('button',{pressed:false});
    fireEvent.click(tiles.find(tile=>tile.getAttribute('aria-label')?.includes('9월 24일')&&!tile.getAttribute('aria-label')?.includes('이동 대기'))!);
    fireEvent.click(screen.getByRole('button',{name:'복원'}));
    await waitFor(()=>expect(mocks.native).toHaveBeenCalledWith('assetLifecycleSet',{assetId:'a',command:'restore',seenRevision:4}));
    await waitFor(()=>expect(restored).toHaveBeenCalledWith(['a']));
    expect(await screen.findByRole('button',{name:/복원 대기/})).toBeTruthy();
  });

  it('selects everything with 전체 선택',async()=>{
    mount();
    fireEvent.click(await screen.findByRole('button',{name:'전체 선택'}));
    expect(screen.getByText('3개 선택')).toBeTruthy();
    fireEvent.click(screen.getByRole('button',{name:'선택 해제'}));
    expect(screen.getByText('복원할 항목을 선택하세요')).toBeTruthy();
  });
});

describe('Viewer trash and undo',()=>{
  type V={items:Asset[];index:number};
  const assets:Asset[]=[{id:'x',kind:'image'},{id:'y',kind:'image'},{id:'z',kind:'image'}];
  let latest:ReturnType<typeof useLibraryTrash<V>>|null=null;
  let viewer:V|null=null;
  function Harness(){
    const [value,setValue]=useState<V|null>({items:assets,index:1});
    viewer=value;
    latest=useLibraryTrash<V>(true,'https://server',update=>setValue(current=>update(current)));
    return <div>{latest.snackbar}<span data-testid="hidden">{[...latest.hidden].join(',')}</span></div>;
  }
  beforeEach(()=>{
    mocks.native.mockImplementation((op:string,payload:{command?:string})=>Promise.resolve(
      op==='assetLifecycleSet'&&payload.command==='restore'?{...state(),cancelled:true}:op==='assetLifecycleSet'?state([row('y','trash')]):state()));
  });

  it('hides the Asset at once, advances to the next one and undoes by cancelling',async()=>{
    render(<Harness/>);
    await waitFor(()=>expect(latest?.available).toBe(true));
    await act(async()=>{await latest!.trash(assets[1],1);});
    expect(mocks.native).toHaveBeenCalledWith('assetLifecycleSet',{assetId:'y',command:'trash',seenRevision:0});
    expect(screen.getByTestId('hidden').textContent).toBe('y');
    expect(viewer?.items.map(item=>item.id)).toEqual(['x','z']);
    expect(viewer?.index).toBe(1);
    expect(screen.getByText('휴지통으로 이동함')).toBeTruthy();
    await act(async()=>{fireEvent.click(screen.getByRole('button',{name:/실행 취소/}));});
    await waitFor(()=>expect(mocks.native).toHaveBeenCalledWith('assetLifecycleSet',{assetId:'y',command:'restore',seenRevision:0}));
    await waitFor(()=>expect(screen.getByTestId('hidden').textContent).toBe(''));
    expect(viewer?.items.map(item=>item.id)).toEqual(['x','y','z']);
    expect(viewer?.index).toBe(1);
  });

  it('dismisses the undo snackbar after about six seconds',async()=>{
    render(<Harness/>);
    await waitFor(()=>expect(latest?.available).toBe(true));
    vi.useFakeTimers();
    await act(async()=>{await latest!.trash(assets[0],0);});
    expect(screen.getByText('휴지통으로 이동함')).toBeTruthy();
    act(()=>{vi.advanceTimersByTime(6100);});
    expect(screen.queryByText('휴지통으로 이동함')).toBeNull();
  });

  it('keeps the Asset visible and says why when the trash cannot be queued',async()=>{
    render(<Harness/>);
    await waitFor(()=>expect(latest?.available).toBe(true));
    mocks.native.mockImplementation(()=>Promise.reject(new Error('앱 연결을 시작하지 못했습니다.')));
    await act(async()=>{await latest!.trash(assets[1],1);});
    expect(viewer?.items).toHaveLength(3);
    expect(screen.getByRole('alert').textContent).toContain('앱 연결을 시작하지 못했습니다.');
  });
});
