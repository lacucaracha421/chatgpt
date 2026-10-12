import {cleanup,fireEvent,render,screen,waitFor} from '@testing-library/react';
import {afterEach,describe,expect,it,vi} from 'vitest';
import {AlbumBatchSheet} from './AlbumBatchSheet';
import type {AlbumMembershipState,MembershipAlbum} from './AlbumMembershipEditor';
import type {ManyReply} from './batchCommands';

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

const reply=(ids:string[],failures:Record<string,string>={}):ManyReply=>({adopted:true,results:ids.map(assetId=>({assetId,ok:!failures[assetId],pending:!failures[assetId],blocked:false,conflictCode:null,message:failures[assetId]??''}))});

describe('AlbumBatchSheet',()=>{
  it('adds every selected asset in one native call and then confirms',async()=>{
    let release!:(value:ManyReply)=>void;const calls:unknown[]=[];
    mocks.native.mockImplementation((operation:string,payload:{assetIds:string[]})=>{
      if(operation==='albumMemberships')return Promise.resolve(state());
      calls.push([operation,payload]);
      return new Promise<ManyReply>(resolve=>{release=resolve;});
    });
    const onComplete=vi.fn();
    render(<AlbumBatchSheet assetIds={['a','b','c']} open onClose={vi.fn()} onComplete={onComplete}/>);

    fireEvent.click(await screen.findByRole('button',{name:'루트'}));
    expect(screen.getByText('0/3')).toBeTruthy();
    expect(calls).toEqual([['albumMembershipSetMany',{albumId:'root',assetIds:['a','b','c'],desiredState:true}]]);
    expect(onComplete).not.toHaveBeenCalled();
    release(reply(['a','b','c']));
    await waitFor(()=>expect(screen.getByText('3/3')).toBeTruthy());
    expect(onComplete).toHaveBeenCalledOnce();
    expect(screen.getByText('3장을 루트에 추가했습니다')).toBeTruthy();
    expect(calls).toHaveLength(1);
  });

  it('sends more than 100 assets as sequential chunks of at most 100',async()=>{
    const ids=Array.from({length:250},(_,index)=>`asset-${index}`),sizes:number[]=[];
    mocks.native.mockImplementation((operation:string,payload:{assetIds:string[]})=>{
      if(operation==='albumMemberships')return Promise.resolve(state());
      sizes.push(payload.assetIds.length);
      return Promise.resolve(reply(payload.assetIds));
    });
    const onComplete=vi.fn();
    render(<AlbumBatchSheet assetIds={ids} open onClose={vi.fn()} onComplete={onComplete}/>);
    fireEvent.click(await screen.findByRole('button',{name:'루트'}));
    await waitFor(()=>expect(onComplete).toHaveBeenCalledOnce());
    expect(sizes).toEqual([100,100,50]);
    expect(screen.getByText('250/250')).toBeTruthy();
  });

  it('reports the failed assets, keeps only them selected and retries only them',async()=>{
    const calls:string[][]=[];
    mocks.native.mockImplementation((operation:string,payload:{assetIds:string[]})=>{
      if(operation==='albumMemberships')return Promise.resolve(state());
      calls.push(payload.assetIds);
      return Promise.resolve(calls.length===1?reply(payload.assetIds,{b:'앨범 연결 충돌을 먼저 해결해 주세요.'}):reply(payload.assetIds));
    });
    const onComplete=vi.fn(),onPartial=vi.fn();
    render(<AlbumBatchSheet assetIds={['a','b','c']} open onClose={vi.fn()} onComplete={onComplete} onPartial={onPartial}/>);
    fireEvent.click(await screen.findByRole('button',{name:'기타'}));

    expect((await screen.findByRole('alert')).textContent).toContain('3개 중 2개 추가, 1개 실패');
    expect(screen.getByRole('alert').textContent).toContain('앨범 연결 충돌');
    expect(onPartial).toHaveBeenCalledWith(['b']);
    expect(onComplete).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole('button',{name:'기타'}));
    await waitFor(()=>expect(onComplete).toHaveBeenCalledOnce());
    expect(calls).toEqual([['a','b','c'],['b']]);
    expect(screen.getByText('1장을 기타에 추가했습니다')).toBeTruthy();
  });

  it('keeps the error visible and does not complete when the native call fails',async()=>{
    const calls:unknown[]=[];
    mocks.native.mockImplementation((operation:string,payload:unknown)=>{
      if(operation==='albumMemberships')return Promise.resolve(state());
      calls.push(payload);
      return Promise.reject(new Error('앨범 저장 실패'));
    });
    const onComplete=vi.fn(),onPartial=vi.fn();
    render(<AlbumBatchSheet assetIds={['a','b']} open onClose={vi.fn()} onComplete={onComplete} onPartial={onPartial}/>);
    fireEvent.click(await screen.findByRole('button',{name:'기타'}));

    expect((await screen.findByRole('alert')).textContent).toContain('앨범 저장 실패');
    expect(calls).toEqual([{albumId:'other',assetIds:['a','b'],desiredState:true}]);
    expect(onPartial).toHaveBeenCalledWith(['a','b']);
    expect(onComplete).not.toHaveBeenCalled();
  });
});
