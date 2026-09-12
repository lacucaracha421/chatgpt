import {act, cleanup, fireEvent, render, screen, waitFor} from '@testing-library/react';
import {afterEach, beforeEach, describe, expect, it, vi} from 'vitest';
import type {Asset} from './types';
import type {HomeProps} from './Home';
const mocks=vi.hoisted(()=>({api:vi.fn(),native:vi.fn()}));
vi.mock('./transport',()=>({api:mocks.api,native:mocks.native,errorText:()=> 'connection failed'}));
vi.mock('./media',()=>({clearMediaCache:vi.fn(),prepareAssets:()=>new Promise(()=>{})}));
vi.mock('./Home',()=>({Home:({items,onOpen,onSelect,recentFolders}:HomeProps)=><div><button onClick={()=>onSelect({tab:'library',title:'최근 저장'})}>전체 보기</button><span>{`recent-folders:${recentFolders.join(',')}`}</span>{items.slice(0,12).map((a,i)=><button key={a.id} onClick={()=>onOpen(i)}>{`tile-${a.id}`}</button>)}</div>}));
vi.mock('./Gallery',()=>({Gallery:({items,onOpen,onNearEnd}:{items:Asset[];onOpen(i:number):void;onNearEnd():void})=><div aria-label="자산 목록" onScroll={onNearEnd}>{items.map((a,i)=><button key={a.id} onClick={()=>onOpen(i)}>{`tile-${a.id}`}</button>)}</div>}));
vi.mock('./Viewer',()=>({Viewer:({items,index,onIndex,onClose}:{items:Asset[];index:number;onIndex(i:number):void;onClose():void})=><div><span>{`viewer-${items[index].id}`}</span><button onClick={()=>onIndex(1)}>viewer next</button><button onClick={onClose}>viewer close</button></div>}));
import {App} from './App';
const a=[{id:'a1',kind:'image'},{id:'a2',kind:'image'}],b=[{id:'b1',kind:'image'},{id:'b2',kind:'image'}];
beforeEach(()=>{
  localStorage.clear(); mocks.api.mockReset(); mocks.native.mockReset();
  mocks.native.mockResolvedValue({configured:true,endpoint:'https://example.invalid'});
  mocks.api.mockImplementation(async(path:string)=>{
    if(path.includes('classifications'))return{items:[{id:'b',name:'분류 B',asset_count:2,parent_id:null}]};
    if(path.includes('revisit'))return{bundles:[]}; if(path.includes('captures'))return{captures:[]};
    return{items:path.includes('classification_id=b')?b:a,has_more:false,next_cursor:null};
  });
});
afterEach(cleanup);
describe('committed view and browsing',()=>{
  it('renders metadata without waiting for thumbnails and appends past 100 without replacing the view',async()=>{
    const original=mocks.api.getMockImplementation()!;
    mocks.api.mockImplementation((path:string)=>{
      if(!path.startsWith('/v1/library/assets?')) return original(path);
      const offset=Number(new URLSearchParams(path.split('?')[1]).get('cursor') ?? 0);
      return Promise.resolve({items:Array.from({length:40},(_,i)=>({id:`n${offset+i}`,kind:'image'})),has_more:offset<80,next_cursor:offset<80?String(offset+40):null});
    });
    render(<App/>); await screen.findByText('tile-n0');
    fireEvent.click(screen.getByRole('button',{name:'전체 보기'})); await screen.findByLabelText('자산 목록');
    const first=screen.getByText('tile-n0');
    expect(screen.queryByText('아래로 스크롤하면 계속 이어집니다')).toBeNull();
    expect(document.querySelector('.page-footer')).toBeNull();
    await waitFor(()=>expect(mocks.api.mock.calls.some(([path])=>path.includes('cursor=40'))).toBe(true));
    fireEvent.scroll(screen.getByLabelText('자산 목록')); await screen.findByText('tile-n79');
    fireEvent.scroll(screen.getByLabelText('자산 목록')); await screen.findByText('tile-n119');
    expect(screen.getByText('tile-n0')).toBe(first);
    expect(screen.queryByRole('button',{name:'더 불러오기'})).toBeNull();
    fireEvent.click(screen.getByText('tile-n119'));
    expect(screen.getByText('viewer-n119')).toBeTruthy();
  });
  it('rejects a late appended page after changing classification',async()=>{
    const original=mocks.api.getMockImplementation()!; let resolveMore!:(value:unknown)=>void;
    mocks.api.mockImplementation((path:string)=>{
      if(path.includes('cursor=next')) return new Promise(resolve=>{resolveMore=resolve;});
      if(path.startsWith('/v1/library/assets?') && !path.includes('classification_id')) return Promise.resolve({items:a,has_more:true,next_cursor:'next'});
      return original(path);
    });
    render(<App/>); await screen.findByText('tile-a1');
    fireEvent.click(screen.getByRole('button',{name:'전체 보기'})); await screen.findByLabelText('자산 목록');
    fireEvent.scroll(screen.getByLabelText('자산 목록'));
    fireEvent.click(screen.getByRole('button',{name:'분류 B2'})); await screen.findByText('tile-b1');
    await act(async()=>{resolveMore({items:[{id:'late',kind:'image'}],has_more:false,next_cursor:null});});
    expect(screen.queryByText('tile-late')).toBeNull(); expect(screen.getByText('tile-b1')).toBeTruthy();
  });
  it('retains loaded items on append failure and deduplicates the retry',async()=>{
    const original=mocks.api.getMockImplementation()!; let fail=true;
    mocks.api.mockImplementation((path:string)=>{
      if(path.includes('cursor=next')) return fail ? Promise.reject(new Error('offline')) : Promise.resolve({items:[a[1],...b],has_more:false,next_cursor:null});
      if(path.startsWith('/v1/library/assets?')) return Promise.resolve({items:a,has_more:true,next_cursor:'next'});
      return original(path);
    });
    render(<App/>); await screen.findByText('tile-a1');
    fireEvent.click(screen.getByRole('button',{name:'전체 보기'})); await screen.findByLabelText('자산 목록');
    fireEvent.scroll(screen.getByLabelText('자산 목록')); await screen.findByText('connection failed');
    expect(screen.getByText('tile-a1')).toBeTruthy(); fail=false;
    fireEvent.click(screen.getByRole('button',{name:'다시 시도'})); await screen.findByText('tile-b1');
    expect(screen.getAllByText('tile-a2')).toHaveLength(1);
  });
  it('starts Home directly with recent media and has no Continue section',async()=>{
    render(<App/>); await screen.findByText('tile-a1');
    expect(screen.queryByText('다시, 이어서.')).toBeNull();
    expect(screen.queryByRole('button',{name:/이어보기/})).toBeNull();
  });
  it('opening the retained gallery cancels a pending replacement and keeps viewer provenance',async()=>{
    const original=mocks.api.getMockImplementation()!; let resolveB!:(value:unknown)=>void;
    mocks.api.mockImplementation((path:string)=>path.includes('classification_id=b')?new Promise(resolve=>{resolveB=resolve;}):original(path));
    render(<App/>); await screen.findByText('tile-a1');
    fireEvent.click(screen.getByRole('button',{name:'분류 B2'}));
    expect(screen.getByText('tile-a1')).toBeTruthy();
    fireEvent.click(screen.getByText('tile-a1'));
    await act(async()=>{resolveB({items:b,has_more:false,next_cursor:null});});
    fireEvent.click(screen.getByText('viewer next')); fireEvent.click(screen.getByText('viewer close'));
    expect(screen.getByText('tile-a1')).toBeTruthy(); expect(screen.queryByText('tile-b1')).toBeNull();
  });
  it('restores the last Library classification when switching tabs',async()=>{
    render(<App/>); await screen.findByText('tile-a1');
    fireEvent.click(screen.getByRole('button',{name:'분류 B2'})); await screen.findByText('tile-b1');
    fireEvent.click(screen.getByRole('button',{name:'Home',exact:true})); await screen.findByText('tile-a1');
    expect(screen.getByText('recent-folders:b')).toBeTruthy();
    fireEvent.click(screen.getByRole('button',{name:'Library',exact:true}));
    await waitFor(()=>expect(screen.getByText('tile-b1')).toBeTruthy());
  });
  it('active Library keeps its classification and native back preserves it for return',async()=>{
    render(<App/>); await screen.findByText('tile-a1');
    fireEvent.click(screen.getByRole('button',{name:'분류 B2'})); await screen.findByText('tile-b1');
    fireEvent.click(screen.getByRole('button',{name:'Library',exact:true}));
    expect(screen.getByText('tile-b1')).toBeTruthy();
    await act(async()=>{window.dispatchEvent(new CustomEvent('lakomics-back'));});
    await screen.findByText('tile-a1');
    fireEvent.click(screen.getByRole('button',{name:'Library',exact:true}));
    await screen.findByText('tile-b1');
  });
});
