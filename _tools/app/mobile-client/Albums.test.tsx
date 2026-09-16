import {cleanup, fireEvent, render, screen, waitFor} from '@testing-library/react';
import {afterEach, beforeEach, describe, expect, it, vi} from 'vitest';
const mocks=vi.hoisted(()=>({api:vi.fn(),native:vi.fn()}));
vi.mock('./transport',()=>({api:mocks.api,native:mocks.native,errorText:(reason:unknown)=>String(reason)}));
vi.mock('./media',()=>({mediaTicket:vi.fn()}));
// The section's contract is which identity and URL it reads under, and what it renders
// when nothing is adopted. The virtualized Gallery has its own check, so it is stubbed
// here to keep this test about the Album section rather than DOM measurement.
vi.mock('./Gallery',()=>({Gallery:({items,onNearEnd}:{items:{id:string}[];onNearEnd():void})=><div className="gallery-scroll"><ul>{items.map(item=><li key={item.id}>{item.id}</li>)}</ul><button data-testid="album-near-end" onClick={onNearEnd}>near end</button></div>}));
import {Albums,albumPath} from './Albums';
import type {AlbumTree,NativeAlbum} from './Albums';
const albums:NativeAlbum[]=[{id:'root',name:'업로드용',parentId:null,iconKey:null,colorKey:null},{id:'child',name:'임시',parentId:'root',iconKey:null,colorKey:null},{id:'other',name:'Other',parentId:null,iconKey:null,colorKey:null}];
const adopted:AlbumTree={adopted:true,libraryId:'a'.repeat(32),epoch:1,code:'',albums};
const unadopted:AlbumTree={adopted:false,libraryId:null,epoch:null,code:'authorityInactive',albums:[]};
const asset=(id:string)=>({id,kind:'image',content_type:'image/png',size_bytes:10,thumbnail_available:true});
beforeEach(()=>{mocks.api.mockReset();mocks.native.mockReset();mocks.native.mockResolvedValue(adopted);mocks.api.mockResolvedValue({items:[asset('a1')],has_more:false,next_cursor:null});});
afterEach(cleanup);
describe('additive albums section',()=>{
  it('renders nothing at all while Album authority is unadopted, so Classification navigation is untouched',async()=>{
    mocks.native.mockResolvedValue(unadopted);
    const {container}=render(<Albums active paused={false} onOpen={()=>{}} backRef={{current:null}}/>);
    await waitFor(()=>expect(mocks.native).toHaveBeenCalledWith('albumTree',{},expect.anything()));
    expect(container.querySelector('.album-section')).toBeNull();
    expect(mocks.api).not.toHaveBeenCalled();
  });
  it('lists replica Albums and reads contents from the authority projection under the adopted identity',async()=>{
    render(<Albums active paused={false} onOpen={()=>{}} backRef={{current:null}}/>);
    await screen.findByText('업로드용');
    expect(screen.getByText('Other')).toBeTruthy();
    // A nested Album is not flattened into the top level.
    expect(screen.queryByText('임시')).toBeNull();
    fireEvent.click(screen.getByText('업로드용'));
    await screen.findByText('a1');
    const path=String(mocks.api.mock.calls.at(-1)?.[0]);
    expect(path).toContain('/v1/albums/assets?');
    expect(path).toContain(`libraryId=${'a'.repeat(32)}`);
    expect(path).toContain('epoch=1');
    expect(path).toContain('albumId=root');
  });
  it('paginates the real Album wire shape with camelCase continuation fields',async()=>{
    mocks.api.mockResolvedValueOnce({items:[asset('a1')],hasMore:true,nextCursor:'album-cursor'})
      .mockResolvedValueOnce({items:[asset('a2')],hasMore:false,nextCursor:null});
    render(<Albums active paused={false} onOpen={()=>{}} backRef={{current:null}}/>);
    fireEvent.click(await screen.findByText('업로드용'));
    await screen.findByText('a1');
    fireEvent.click(screen.getByTestId('album-near-end'));
    await screen.findByText('a2');
    expect(String(mocks.api.mock.calls.at(-1)?.[0])).toContain('cursor=album-cursor');
  });
  it('places the Album Gallery inside a constrained dialog content region',async()=>{
    render(<Albums active paused={false} onOpen={()=>{}} backRef={{current:null}}/>);
    fireEvent.click(await screen.findByText('업로드용'));
    await screen.findByText('a1');
    expect(document.querySelector('.album-dialog-content .gallery-scroll')).not.toBeNull();
  });
  it('shows a nested Album and its breadcrumb rather than merging it into the parent',async()=>{
    render(<Albums active paused={false} onOpen={()=>{}} backRef={{current:null}}/>);
    fireEvent.click(await screen.findByText('업로드용'));
    fireEvent.click(await screen.findByText('임시'));
    await waitFor(()=>expect(String(mocks.api.mock.calls.at(-1)?.[0])).toContain('albumId=child'));
    expect(screen.getAllByText('업로드용 / 임시').length).toBeGreaterThan(0);
  });
  it('surfaces an authority failure instead of rendering an empty Album',async()=>{
    mocks.api.mockRejectedValue(new Error('앨범 권위가 아직 활성화되지 않았습니다.'));
    render(<Albums active paused={false} onOpen={()=>{}} backRef={{current:null}}/>);
    fireEvent.click(await screen.findByText('업로드용'));
    await screen.findByText(/앨범 권위가 아직 활성화되지 않았습니다/);
    expect(screen.queryByText('이 앨범에 자산이 없습니다')).toBeNull();
  });
  it('bounds a cyclic hierarchy instead of hanging',()=>{
    const cyclic:NativeAlbum[]=[{id:'x',name:'X',parentId:'y',iconKey:null,colorKey:null},{id:'y',name:'Y',parentId:'x',iconKey:null,colorKey:null}];
    expect(albumPath(cyclic,'x')).toBe('Y / X');
  });
  it('lets back close the Album dialog before leaving the library',async()=>{
    const backRef:{current:(()=>boolean)|null}={current:null};
    render(<Albums active paused={false} onOpen={()=>{}} backRef={backRef}/>);
    fireEvent.click(await screen.findByText('업로드용'));
    await screen.findByText('a1');
    expect(backRef.current?.()).toBe(true);
    await waitFor(()=>expect(screen.queryByText('a1')).toBeNull());
    expect(backRef.current?.()).toBe(false);
  });
});
