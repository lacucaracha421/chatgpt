import {cleanup,fireEvent,render,screen,waitFor} from '@testing-library/react';
import {afterEach,describe,expect,it,vi} from 'vitest';
import {AlbumBatchSheet} from './AlbumBatchSheet';
import type {AlbumMembershipState,MembershipAlbum} from './AlbumMembershipEditor';

const mocks=vi.hoisted(()=>({native:vi.fn()}));
vi.mock('./transport',()=>({native:mocks.native,errorText:(reason:unknown)=>reason instanceof Error?reason.message:String(reason)}));
vi.mock('./BottomSheet',()=>({BottomSheet:({children}:{children:unknown})=><div>{children}</div>}));

const albums:MembershipAlbum[]=[
  {id:'root',name:'루트',parentId:null,desiredState:false,pending:false,blocked:false,conflictCode:null},
  {id:'child',name:'하위',parentId:'root',desiredState:false,pending:false,blocked:false,conflictCode:null},
  {id:'other',name:'기타',parentId:null,desiredState:false,pending:false,blocked:false,conflictCode:null},
];
const state=():AlbumMembershipState=>({adopted:true,libraryId:'a'.repeat(32),epoch:1,albums});

afterEach(()=>{cleanup();mocks.native.mockReset();});

describe('AlbumBatchSheet',()=>{
  it('loads the tree and adds every selected asset sequentially with progress',async()=>{
    const resolvers:Array<(value:AlbumMembershipState)=>void>=[],calls:unknown[]=[];
    mocks.native.mockImplementation((operation:string,payload:unknown)=>{
      if(operation==='albumMemberships')return Promise.resolve(state());
      calls.push(payload);
      return new Promise<AlbumMembershipState>(resolve=>resolvers.push(resolve));
    });
    const onComplete=vi.fn();
    render(<AlbumBatchSheet assetIds={['a','b','c']} open onClose={vi.fn()} onComplete={onComplete}/>);

    const album=await screen.findByRole('button',{name:'루트'});
    fireEvent.click(album);
    expect(screen.getByText('0/3')).toBeTruthy();
    expect(calls).toEqual([{assetId:'a',albumId:'root',desiredState:true}]);
    expect(resolvers).toHaveLength(1);

    resolvers[0](state());
    await waitFor(()=>expect(screen.getByText('1/3')).toBeTruthy());
    expect(calls).toHaveLength(2);
    expect(resolvers).toHaveLength(2);
    resolvers[1](state());
    await waitFor(()=>expect(screen.getByText('2/3')).toBeTruthy());
    expect(calls).toHaveLength(3);
    resolvers[2](state());
    await waitFor(()=>expect(screen.getByText('3/3')).toBeTruthy());
    expect(onComplete).toHaveBeenCalledOnce();
    expect(screen.getByText('3장을 루트에 추가했습니다')).toBeTruthy();
  });

  it('stops at the first native error and keeps the error visible',async()=>{
    const calls:unknown[]=[];
    mocks.native.mockImplementation((operation:string,payload:unknown)=>{
      if(operation==='albumMemberships')return Promise.resolve(state());
      calls.push(payload);
      return Promise.reject(new Error('앨범 저장 실패'));
    });
    const onComplete=vi.fn();
    render(<AlbumBatchSheet assetIds={['a','b']} open onClose={vi.fn()} onComplete={onComplete}/>);
    fireEvent.click(await screen.findByRole('button',{name:'기타'}));

    expect((await screen.findByRole('alert')).textContent).toContain('앨범 저장 실패');
    expect(calls).toEqual([{assetId:'a',albumId:'other',desiredState:true}]);
    expect(screen.getByText('0/2')).toBeTruthy();
    expect(onComplete).not.toHaveBeenCalled();
  });
});
