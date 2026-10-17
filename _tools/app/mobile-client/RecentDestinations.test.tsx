import {act,cleanup,fireEvent,render,renderHook,screen,waitFor,within} from '@testing-library/react';
import {afterEach,beforeEach,describe,expect,it,vi} from 'vitest';
import type {ReactNode} from 'react';
import {ClassificationBatchSheet} from './ClassificationBatchSheet';
import {ClassificationAssignmentEditor} from './ClassificationAssignmentEditor';
import type {ClassificationAssignmentState} from './ClassificationAssignmentEditor';
import {AlbumBatchSheet} from './AlbumBatchSheet';
import type {AlbumMembershipState,MembershipAlbum} from './AlbumMembershipEditor';
import {ALBUM_FILLED_EVENT,RecentDestinationsContext,readRecentAlbums,useTabletRecentAlbums,type RecentDestinationIds} from './recentDestinationHistory';
import {FOLDER_FILLED_EVENT} from './recentFolders';

const mocks=vi.hoisted(()=>({native:vi.fn()}));
vi.mock('./transport',()=>({native:mocks.native,errorText:(e:unknown)=>e instanceof Error?e.message:String(e)}));
vi.mock('./BottomSheet',()=>({BottomSheet:({title,onClose,children,actions}:{title:string;onClose():void;children:ReactNode;actions?:ReactNode})=><section><h2>{title}</h2>{children}<div><button onClick={onClose}>닫기</button>{actions}</div></section>}));

const tree=[
  {id:'game',name:'게임',kind:'root' as const,parentId:null,iconKey:null,colorKey:null},
  {id:'genshin',name:'원신',kind:'work' as const,parentId:'game',iconKey:null,colorKey:null},
  {id:'anime',name:'애니',kind:'root' as const,parentId:null,iconKey:null,colorKey:null},
];
const state=(assetId:string,classificationId:string|null):ClassificationAssignmentState=>({adopted:true,assetId,classificationId,classifications:tree});
const many=(ids:string[],failing=new Set<string>())=>({adopted:true,results:ids.map(assetId=>({assetId,ok:!failing.has(assetId),pending:false,blocked:false,conflictCode:null,message:failing.has(assetId)?'저장 실패':''}))});
const recent=(folders:string[],albums:string[]=[]):RecentDestinationIds=>({folders,albums});
const withRecent=(value:RecentDestinationIds,child:ReactNode)=><RecentDestinationsContext.Provider value={value}>{child}</RecentDestinationsContext.Provider>;
const row=()=>screen.queryByRole('group',{name:'최근 분류'});
const setMany=()=>mocks.native.mock.calls.filter(([op])=>op==='classificationAssignmentSetMany').map(([,payload])=>payload);

beforeEach(()=>{localStorage.clear();});
afterEach(()=>{cleanup();mocks.native.mockReset();});

describe('recent folders in the 분류 batch sheet',()=>{
  const open=(assetIds:string[],held:Record<string,string|null>={})=>{
    mocks.native.mockImplementation((op:string,p:{assetId:string;assetIds:string[]})=>op==='classificationAssignmentSetMany'?Promise.resolve(many(p.assetIds)):Promise.resolve(state(p.assetId,held[p.assetId]??null)));
    const callbacks={onClose:vi.fn(),onComplete:vi.fn(),onBusyChange:vi.fn()};
    render(withRecent(recent(['genshin','gone','anime']),<ClassificationBatchSheet assetIds={assetIds} {...callbacks}/>));
    return callbacks;
  };

  it('shows no row without a history, and skips folders that no longer exist',async()=>{
    mocks.native.mockImplementation((_op:string,p:{assetId:string})=>Promise.resolve(state(p.assetId,null)));
    const view=render(<ClassificationBatchSheet assetIds={['a']} onClose={vi.fn()} onComplete={vi.fn()} onBusyChange={vi.fn()}/>);
    await screen.findByRole('radio',{name:'게임'});
    expect(row()).toBeNull();
    view.unmount();
    open(['a']);
    await screen.findByRole('radio',{name:'게임'});
    expect(within(row()!).getAllByRole('button').map(button=>button.textContent)).toEqual(['원신','애니']);
  });

  it('applies on one tap, shows the done state in place, closes by itself and keeps the selection',async()=>{
    const callbacks=open(['a','b']);
    const chip=await screen.findByRole('button',{name:'원신'});
    fireEvent.click(chip);
    await waitFor(()=>expect(chip.classList.contains('is-done')).toBe(true));
    expect(setMany()).toEqual([{assetIds:['a','b'],classificationId:'genshin'}]);
    expect(screen.getByText('2/2개 분류 변경 · 원신')).toBeTruthy();
    // No toast and no completion that would clear the selection; the sheet closes after 0.9 s.
    expect(callbacks.onComplete).not.toHaveBeenCalled();
    expect(callbacks.onClose).not.toHaveBeenCalled();
    // Another tap during the done state does nothing.
    fireEvent.click(screen.getByRole('button',{name:'애니'}));
    expect(setMany()).toHaveLength(1);
    await waitFor(()=>expect(callbacks.onClose).toHaveBeenCalledOnce(),{timeout:2500});
  });

  it('dims and disables a folder that already holds every selected image',async()=>{
    open(['a','b'],{a:'anime',b:'anime'});
    const held=await screen.findByRole('button',{name:'애니'});
    expect(held.getAttribute('aria-disabled')).toBe('true');
    fireEvent.click(held);
    expect(setMany()).toHaveLength(0);
    // One image elsewhere makes it a valid destination again.
    cleanup();mocks.native.mockReset();
    open(['a','b'],{a:'anime',b:'game'});
    expect((await screen.findByRole('button',{name:'애니'})).getAttribute('aria-disabled')).toBeNull();
  });

  it('keeps the sheet open on a failure and retries from the message',async()=>{
    let fail=true;
    mocks.native.mockImplementation((op:string,p:{assetId:string;assetIds:string[]})=>op==='classificationAssignmentSetMany'?Promise.resolve(many(p.assetIds,fail?new Set(['b']):new Set())):Promise.resolve(state(p.assetId,null)));
    const callbacks={onClose:vi.fn(),onComplete:vi.fn(),onBusyChange:vi.fn()};
    render(withRecent(recent(['genshin']),<ClassificationBatchSheet assetIds={['a','b']} {...callbacks}/>));
    fireEvent.click(await screen.findByRole('button',{name:'원신'}));
    expect((await screen.findByRole('alert')).textContent).toContain('저장 실패');
    expect(document.querySelector('.is-done')).toBeNull();
    fail=false;
    fireEvent.click(screen.getByRole('button',{name:'다시 시도'}));
    await waitFor(()=>expect(document.querySelector('.is-done')).toBeTruthy());
    expect(setMany()).toHaveLength(2);
    await waitFor(()=>expect(callbacks.onClose).toHaveBeenCalledOnce(),{timeout:2500});
  });
});

describe('recent folders in the viewer 분류 editor',()=>{
  it('applies a chip with one tap, then closes by itself',async()=>{
    mocks.native.mockImplementation((op:string)=>Promise.resolve(op==='classificationAssignmentSet'?state('a','genshin'):state('a','anime')));
    const onClose=vi.fn();
    render(withRecent(recent(['anime','genshin']),<ClassificationAssignmentEditor assetId="a" open onClose={onClose}/>));
    // The folder the image is already in cannot be picked again.
    expect((await screen.findByRole('button',{name:'애니'})).getAttribute('aria-disabled')).toBe('true');
    fireEvent.click(screen.getByRole('button',{name:'원신'}));
    await waitFor(()=>expect(mocks.native).toHaveBeenCalledWith('classificationAssignmentSet',{assetId:'a',classificationId:'genshin'}));
    await waitFor(()=>expect(screen.getByRole('button',{name:'원신'}).classList.contains('is-done')).toBe(true));
    expect(onClose).not.toHaveBeenCalled();
    await waitFor(()=>expect(onClose).toHaveBeenCalledOnce(),{timeout:2500});
  });
});

describe('recent albums',()=>{
  const albums:MembershipAlbum[]=[
    {id:'one',name:'모음',parentId:null,desiredState:false,pending:false,blocked:false,conflictCode:null},
    {id:'two',name:'배경',parentId:null,desiredState:false,pending:false,blocked:false,conflictCode:null},
  ];
  const membership=(held:string[]):AlbumMembershipState=>({adopted:true,libraryId:'a'.repeat(32),epoch:1,albums:albums.map(album=>({...album,desiredState:held.includes(album.id)}))});

  it('adds on one tap, records the album, closes by itself and does not clear the selection',async()=>{
    mocks.native.mockImplementation((op:string,p:{assetIds?:string[]})=>op==='albumMemberships'?Promise.resolve(membership([])):Promise.resolve(many(p.assetIds??[])));
    const onClose=vi.fn(),onComplete=vi.fn(),filled=vi.fn();
    window.addEventListener(ALBUM_FILLED_EVENT,filled);
    try{
      render(withRecent(recent([],['two']),<AlbumBatchSheet assetIds={['a','b']} open onClose={onClose} onComplete={onComplete}/>));
      const group=await screen.findByRole('group',{name:'최근 앨범'});
      fireEvent.click(within(group).getByRole('button',{name:'배경'}));
      await waitFor(()=>expect(screen.getByText('2장을 배경에 추가했습니다')).toBeTruthy());
      expect(onComplete).not.toHaveBeenCalled();
      expect(filled).toHaveBeenCalledOnce();
      await waitFor(()=>expect(onClose).toHaveBeenCalledOnce(),{timeout:2500});
    }finally{window.removeEventListener(ALBUM_FILLED_EVENT,filled);}
  });

  it('dims an album that already holds every selected image',async()=>{
    mocks.native.mockImplementation((op:string,p:{assetId?:string})=>op==='albumMemberships'?Promise.resolve(membership(p.assetId==='b'?['one']:['one','two'])):Promise.resolve(many([])));
    render(withRecent(recent([],['one','two']),<AlbumBatchSheet assetIds={['a','b']} open onClose={vi.fn()} onComplete={vi.fn()}/>));
    const group=await screen.findByRole('group',{name:'최근 앨범'});
    await waitFor(()=>expect(within(group).getByRole('button',{name:'모음'}).getAttribute('aria-disabled')).toBe('true'));
    expect(within(group).getByRole('button',{name:'배경'}).getAttribute('aria-disabled')).toBeNull();
  });

  it('keeps its own per-device history, newest first, and follows the filled event',()=>{
    const {result}=renderHook(()=>useTabletRecentAlbums('lib'));
    expect(result.current).toEqual([]);
    const fill=(albumId:string)=>act(()=>{window.dispatchEvent(new CustomEvent(ALBUM_FILLED_EVENT,{detail:{albumId}}));});
    fill('one');fill('two');fill('one');
    expect(result.current).toEqual(['one','two']);
    expect(readRecentAlbums('lib')).toEqual(['one','two']);
    expect(readRecentAlbums('other-library')).toEqual([]);
    // Folder history is a separate event and is not mixed in.
    act(()=>{window.dispatchEvent(new CustomEvent(FOLDER_FILLED_EVENT,{detail:{classificationId:'x'}}));});
    expect(result.current).toEqual(['one','two']);
  });
});
