import {act,cleanup,fireEvent,render,screen,waitFor,within} from '@testing-library/react';
import {afterEach,beforeEach,describe,expect,it,vi} from 'vitest';
import {AlbumManagement} from './AlbumManagement';
import {ALBUM_TREE_CHANGED,readAlbumSnapshot} from './albumCommands';
import {useAlbumTree} from './Albums';
import type {AlbumTree} from './albumModel';
const mocks=vi.hoisted(()=>({api:vi.fn(),native:vi.fn()}));
vi.mock('./transport',()=>({api:mocks.api,native:mocks.native,errorText:(reason:unknown)=>reason instanceof Error?reason.message:String(reason)}));
const album={id:'album',name:'여행',parentId:null,iconKey:null,colorKey:null,entityRevision:7,deleted:false};
const tree:AlbumTree={adopted:true,libraryId:'a'.repeat(32),epoch:2,code:'',albums:[album]};
const baseline=(extra={})=>({libraryId:tree.libraryId,epoch:2,snapshotCursor:10,items:[album],hasMore:false,nextAfter:null,likesAlbumId:null,...extra});
const commands=()=>mocks.api.mock.calls.filter(([path])=>path==='/v1/albums/commands');
beforeEach(()=>{
  vi.stubGlobal('matchMedia',()=>({matches:false,addEventListener(){},removeEventListener(){}}));
  mocks.api.mockReset();mocks.native.mockReset();
  mocks.native.mockResolvedValue(tree);
  mocks.api.mockImplementation(async(path:string,_signal:unknown,body:Record<string,unknown>)=>path.includes('/baseline')?baseline():{album:{...album,...body,id:body.albumId,entityRevision:8,deleted:body.commandType==='deleteAlbum'}});
});
afterEach(()=>{cleanup();vi.unstubAllGlobals();});
describe('tablet album management',()=>{
  it('creates an album using the authority identity and publishes its confirmed row',async()=>{
    const close=vi.fn(),changed=vi.fn();window.addEventListener(ALBUM_TREE_CHANGED,changed);
    try {
      render(<AlbumManagement tree={tree} onClose={close}/>);
      fireEvent.change(screen.getByLabelText('앨범 이름'),{target:{value:'  새 여행  '}});
      await waitFor(()=>expect((screen.getByRole('button',{name:'만들기'}) as HTMLButtonElement).disabled).toBe(false));
      fireEvent.click(screen.getByRole('button',{name:'만들기'}));
      await waitFor(()=>expect(close).toHaveBeenCalledOnce());
      expect(commands()[0][2]).toMatchObject({libraryId:tree.libraryId,epoch:2,contractVersion:1,commandType:'createAlbum',name:'새 여행',parentId:null,iconKey:null,colorKey:null});
      expect(commands()[0][2].albumId).not.toBe(album.id);expect(commands()[0][3]).toBe('PUT');
      expect(changed.mock.calls[0][0].detail.albums).toHaveLength(2);
    } finally {window.removeEventListener(ALBUM_TREE_CHANGED,changed);}
  });
  it('creates a child with a new id rather than overwriting its parent',async()=>{
    render(<AlbumManagement tree={tree} album={album} onClose={vi.fn()}/>);
    fireEvent.click(await screen.findByRole('button',{name:'하위 앨범 만들기'}));
    fireEvent.click(screen.getByRole('button',{name:'만들기'}));
    await waitFor(()=>expect(commands()).toHaveLength(1));
    expect(commands()[0][2]).toMatchObject({commandType:'createAlbum',parentId:album.id});
    expect(commands()[0][2].albumId).not.toBe(album.id);
  });
  it('renames with the inspected entity revision and keeps the sheet on conflict',async()=>{
    const close=vi.fn();
    mocks.api.mockImplementation(async(path:string)=>{if(path.includes('/baseline'))return baseline();throw new Error('다른 기기에서 변경되었습니다.');});
    render(<AlbumManagement tree={tree} album={album} onClose={close}/>);
    await waitFor(()=>expect((screen.getByRole('button',{name:'이름 바꾸기'}) as HTMLButtonElement).disabled).toBe(false));
    fireEvent.click(screen.getByRole('button',{name:'이름 바꾸기'}));
    fireEvent.change(screen.getByLabelText('앨범 이름'),{target:{value:'가족'}});fireEvent.click(screen.getByRole('button',{name:'저장'}));
    expect(await screen.findByRole('alert')).toBeTruthy();expect(close).not.toHaveBeenCalled();
    expect(commands()[0][2]).toMatchObject({commandType:'renameAlbum',name:'가족',expectedRevision:7});
  });
  it('uses the shared PC icon and colour choices',async()=>{
    render(<AlbumManagement tree={tree} album={album} onClose={vi.fn()}/>);
    await waitFor(()=>expect((screen.getByRole('button',{name:'아이콘 및 색상'}) as HTMLButtonElement).disabled).toBe(false));
    fireEvent.click(screen.getByRole('button',{name:'아이콘 및 색상'}));
    fireEvent.click(screen.getByRole('button',{name:'별'}));fireEvent.click(screen.getByRole('button',{name:'파랑'}));
    fireEvent.click(screen.getByRole('button',{name:'저장'}));
    await waitFor(()=>expect(commands()).toHaveLength(1));
    expect(commands()[0][2]).toMatchObject({commandType:'updateAlbumAppearance',iconKey:'star',colorKey:'blue',expectedRevision:7});
  });
  it('requires deletion confirmation and cancellation sends no command',async()=>{
    render(<AlbumManagement tree={tree} album={album} onClose={vi.fn()}/>);
    await waitFor(()=>expect((screen.getByRole('button',{name:'삭제'}) as HTMLButtonElement).disabled).toBe(false));
    fireEvent.click(screen.getByRole('button',{name:'삭제'}));
    expect(screen.getByRole('dialog',{name:'앨범 삭제'}).textContent).toContain('원본 파일과 일반 폴더는 유지됩니다.');
    expect(commands()).toHaveLength(0);fireEvent.click(screen.getByRole('button',{name:'취소'}));expect(commands()).toHaveLength(0);
  });
  it('deletes only the album entity after confirmation',async()=>{
    const deleted=vi.fn();render(<AlbumManagement tree={tree} album={album} onClose={vi.fn()} onDeleted={deleted}/>);
    await waitFor(()=>expect((screen.getByRole('button',{name:'삭제'}) as HTMLButtonElement).disabled).toBe(false));
    fireEvent.click(screen.getByRole('button',{name:'삭제'}));fireEvent.click(within(screen.getByRole('dialog',{name:'앨범 삭제'})).getByRole('button',{name:'삭제'}));
    await waitFor(()=>expect(deleted).toHaveBeenCalledOnce());
    expect(commands()[0][2]).toMatchObject({commandType:'deleteAlbum',albumId:album.id,expectedRevision:7});
  });
  it.each(['designated','children'])('protects an album with %s semantics',async condition=>{
    mocks.api.mockResolvedValue(baseline(condition==='designated'?{likesAlbumId:album.id}:{items:[album,{...album,id:'child',parentId:album.id}]}));
    render(<AlbumManagement tree={tree} album={album} onClose={vi.fn()}/>);
    await screen.findByText(condition==='designated'?'마음에 들어요 앨범은 삭제할 수 없습니다.':'하위 앨범이 있는 앨범은 삭제할 수 없습니다.');
    expect((screen.getByRole('button',{name:'삭제'}) as HTMLButtonElement).disabled).toBe(true);expect(commands()).toHaveLength(0);
  });
  it('pins pagination to the first snapshot and excludes tombstones',async()=>{
    mocks.api.mockResolvedValueOnce(baseline({hasMore:true,nextAfter:'album'})).mockResolvedValueOnce(baseline({items:[{...album,id:'gone',deleted:true}]}));
    expect((await readAlbumSnapshot(tree)).albums).toEqual([album]);
    expect(mocks.api.mock.calls[1][0]).toContain('&snapshot=10&after=album');
  });
  it('keeps a confirmed rename when the native replica is still stale on resume',async()=>{
    function Host(){const {tree:current}=useAlbumTree(true,1,'endpoint');return <span>{current?.albums[0]?.name}</span>;}
    render(<Host/>);await screen.findByText('여행');
    act(()=>window.dispatchEvent(new CustomEvent(ALBUM_TREE_CHANGED,{detail:{...tree,albums:[{...album,name:'가족'}]}})));
    mocks.api.mockResolvedValue(baseline({items:[{...album,name:'가족',entityRevision:8}]}));
    act(()=>window.dispatchEvent(new Event('lakomics-resume')));
    await waitFor(()=>expect(mocks.api).toHaveBeenCalled());expect(screen.getByText('가족')).toBeTruthy();
  });
});
