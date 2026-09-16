import {cleanup,fireEvent,render,screen,waitFor} from '@testing-library/react';
import {afterEach,beforeEach,describe,expect,it,vi} from 'vitest';
const mocks=vi.hoisted(()=>({native:vi.fn()}));
vi.mock('./transport',()=>({native:mocks.native,errorText:(e:unknown)=>e instanceof Error?e.message:String(e)}));
import {AlbumMembershipEditor,flattenMembershipAlbums} from './AlbumMembershipEditor';
import type {AlbumMembershipState,MembershipAlbum} from './AlbumMembershipEditor';

const albums:MembershipAlbum[]=[
  {id:'root',name:'루트',parentId:null,desiredState:false,pending:false,blocked:false,conflictCode:null},
  {id:'child',name:'하위',parentId:'root',desiredState:true,pending:false,blocked:false,conflictCode:null},
  {id:'other',name:'기타',parentId:null,desiredState:false,pending:false,blocked:false,conflictCode:null},
];
const state=(rows=albums):AlbumMembershipState=>({adopted:true,libraryId:'a'.repeat(32),epoch:1,albums:rows});
afterEach(()=>{cleanup();vi.useRealTimers();});
beforeEach(()=>{mocks.native.mockReset();mocks.native.mockResolvedValue(state());});

describe('Album membership editor',()=>{
  it('flattens the hierarchy parent-first without losing roots',()=>{
    expect(flattenMembershipAlbums(albums).map(row=>[row.album.id,row.depth])).toEqual([
      ['other',0],['root',0],['child',1],
    ]);
  });

  it('loads current memberships and renders nested checkboxes',async()=>{
    render(<AlbumMembershipEditor assetId="asset_1" open onClose={()=>{}}/>);
    const child=await screen.findByRole('checkbox',{name:'하위'});
    expect((child as HTMLInputElement).checked).toBe(true);
    expect(screen.getByText('하위').closest('label')?.getAttribute('style')).toContain('padding-left');
    expect(mocks.native).toHaveBeenCalledWith('albumMemberships',{assetId:'asset_1'},expect.any(AbortSignal));
  });

  it('shows the new desired state and 저장 대기 immediately while native persists it',async()=>{
    let resolve!: (value:AlbumMembershipState)=>void;
    mocks.native.mockResolvedValueOnce(state()).mockImplementationOnce(()=>new Promise(r=>{resolve=r;}));
    render(<AlbumMembershipEditor assetId="asset_1" open onClose={()=>{}}/>);
    const root=await screen.findByRole('checkbox',{name:'루트'});
    fireEvent.click(root);
    expect((root as HTMLInputElement).checked).toBe(true);
    expect(screen.getByText('저장 대기')).toBeTruthy();
    expect(mocks.native).toHaveBeenLastCalledWith('albumMembershipSet',
      {assetId:'asset_1',albumId:'root',desiredState:true});
    resolve(state([{...albums[0],desiredState:true,pending:true},albums[1],albums[2]]));
    await waitFor(()=>expect(screen.getByText('저장 대기')).toBeTruthy());
  });

  it('keeps a blocked optimistic state visible and prevents another toggle',async()=>{
    mocks.native.mockResolvedValue(state([{...albums[0],desiredState:true,blocked:true,conflictCode:'revisionConflict'}]));
    render(<AlbumMembershipEditor assetId="asset_1" open onClose={()=>{}}/>);
    const root=await screen.findByRole('checkbox',{name:'루트'});
    expect((root as HTMLInputElement).checked).toBe(true);
    expect((root as HTMLInputElement).disabled).toBe(true);
    expect(screen.getByText('동기화 충돌')).toBeTruthy();
  });

  it('lets the user explicitly discard the blocked intent and refreshes to server state',async()=>{
    const blocked=state([{...albums[0],desiredState:true,blocked:true,conflictCode:'revisionConflict'}]);
    const resolved=state([{...albums[0],desiredState:false,blocked:false,conflictCode:null}]);
    mocks.native.mockResolvedValueOnce(blocked).mockResolvedValueOnce(resolved);
    render(<AlbumMembershipEditor assetId="asset_1" open onClose={()=>{}}/>);
    await screen.findByText('동기화 충돌');
    fireEvent.click(screen.getByRole('button',{name:'서버 상태 사용'}));
    expect(mocks.native).toHaveBeenLastCalledWith('albumMembershipResolve',
      {assetId:'asset_1',albumId:'root',action:'useServerState'});
    await waitFor(()=>expect((screen.getByRole('checkbox',{name:'루트'}) as HTMLInputElement).checked).toBe(false));
    expect(screen.queryByText('동기화 충돌')).toBeNull();
  });

  it('lets the user retry with a fresh native operation and refreshes to pending state',async()=>{
    const blocked=state([{...albums[0],desiredState:true,blocked:true,conflictCode:'revisionConflict'}]);
    const retried=state([{...albums[0],desiredState:true,pending:true,blocked:false,conflictCode:null}]);
    mocks.native.mockResolvedValueOnce(blocked).mockResolvedValueOnce(retried);
    render(<AlbumMembershipEditor assetId="asset_1" open onClose={()=>{}}/>);
    await screen.findByText('동기화 충돌');
    fireEvent.click(screen.getByRole('button',{name:'내 선택 다시 적용'}));
    expect(mocks.native).toHaveBeenLastCalledWith('albumMembershipResolve',
      {assetId:'asset_1',albumId:'root',action:'applyAgain'});
    await waitFor(()=>expect(screen.getByText('저장 대기')).toBeTruthy());
    expect(screen.queryByText('동기화 충돌')).toBeNull();
  });

  it('refreshes small native state every five seconds while open',async()=>{
    vi.useFakeTimers();
    mocks.native.mockResolvedValueOnce(state([{...albums[0],desiredState:true,pending:true}]))
      .mockResolvedValueOnce(state([{...albums[0],desiredState:true,pending:false}]));
    render(<AlbumMembershipEditor assetId="asset_1" open onClose={()=>{}}/>);
    await vi.waitFor(()=>expect(mocks.native).toHaveBeenCalledTimes(1));
    await vi.advanceTimersByTimeAsync(0);
    await vi.waitFor(()=>expect(screen.getByText('저장 대기')).toBeTruthy());
    await vi.advanceTimersByTimeAsync(5000);
    await vi.waitFor(()=>expect(mocks.native).toHaveBeenCalledTimes(2));
    await vi.advanceTimersByTimeAsync(0);
    await vi.waitFor(()=>expect(screen.queryByText('저장 대기')).toBeNull());
  });
});
