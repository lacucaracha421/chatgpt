import {act,cleanup,fireEvent,render,screen,waitFor,within} from '@testing-library/react';
import {afterEach,beforeEach,expect,it,vi} from 'vitest';
const mocks=vi.hoisted(()=>({api:vi.fn(),native:vi.fn(),commit:vi.fn()}));
vi.mock('./transport',()=>({api:mocks.api,native:mocks.native,errorText:(reason:unknown)=>reason instanceof Error?reason.message:String(reason),ApiError:class extends Error{status=404;}}));
vi.mock('./media',()=>({clearMediaCache:vi.fn(),loadThumbnail:vi.fn(async(asset)=>asset)}));
vi.mock('./collectionArtwork',()=>({useCoverUrl:()=>null}));
vi.mock('./artistEditOutbox',()=>({commitArtistEdit:mocks.commit}));
import {FolderCards} from './FolderCards';
import {FolderActionSheet} from './FolderActions';
import {AlbumActionSheet} from './AlbumActions';
import {Albums} from './Albums';
import {ShelfTile} from './CollectionShelf';
import {CollectionActionSheet} from './CollectionActions';
import {ArtistActionSheet} from './ArtistActions';
import {ImageActionSheet} from './ImageActions';
import type {Entry} from './libraryModel';
import type {AlbumTree,NativeAlbum} from './albumModel';
import type {CollectionSummary} from './collectionModel';
import type {LibraryArtist} from './artistsModel';
import type {Asset} from './types';

const folder=(id:string,name:string,parent_id:string|null=null,extra:Partial<Entry>={}):Entry=>({id,name,parent_id,asset_count:12,total_asset_count:30,...extra});
const album=(id:string,name:string,parentId:string|null=null):NativeAlbum=>({id,name,parentId,iconKey:null,colorKey:null,assetCount:7});
const tree=(albums:NativeAlbum[]):AlbumTree=>({adopted:true,libraryId:'a'.repeat(32),epoch:1,code:'',albums});
const work=(extra:Partial<CollectionSummary>={}):CollectionSummary=>({id:'w1',name:'엘든 링',type:'game',showcase:false,year:2022,developer:'FromSoftware',...extra});
const artist=(extra:Partial<LibraryArtist>={}):LibraryArtist=>({id:'ar1',label:'mizuiro',keys:[],assetCount:251,recentCount:3,pinned:false,hidden:false,main:true,coverAssetIds:[],...extra});
const image=(id:string,extra:Partial<Asset>={}):Asset=>({id,kind:'image',...extra});

beforeEach(()=>{
  vi.stubGlobal('matchMedia',()=>({matches:false,addEventListener(){},removeEventListener(){}}));
  vi.stubGlobal('ResizeObserver',class{observe(){}disconnect(){}});
  mocks.api.mockReset();mocks.native.mockReset();mocks.commit.mockReset();
  mocks.api.mockImplementation(async()=>({items:[],has_more:false,next_cursor:null}));
  mocks.native.mockImplementation(async()=>({}));
});
afterEach(()=>{cleanup();vi.useRealTimers();vi.unstubAllGlobals();});

/** Holds the pointer on `target` long enough to be a long press, then lets go. */
async function hold(target:HTMLElement){
  vi.useFakeTimers();
  fireEvent.pointerDown(target,{button:0,clientX:40,clientY:40});
  await act(async()=>{vi.advanceTimersByTime(450);});
  fireEvent.pointerUp(target,{button:0});
  vi.useRealTimers();
}
const sheetItems=(dialog:HTMLElement)=>within(dialog).getAllByRole('button').map(button=>button.textContent?.replace(/\s+/g,' ').trim());

it('opens a plain folder card\'s sheet on a long press without opening the folder, and gives character folders none',async()=>{
  const onSelect=vi.fn(),onActions=vi.fn();
  const plain=folder('p','부모'),series=folder('s','시리즈',null,{characterNode:'series:s'});
  render(<FolderCards items={[plain,series]} entries={[plain,series]} paused revision={0} onSelect={onSelect} onActions={onActions}/>);
  const card=screen.getByRole('button',{name:'부모, 30개'});
  await hold(card);
  expect(onActions).toHaveBeenCalledWith(plain);
  fireEvent.click(card);
  expect(onSelect).not.toHaveBeenCalled();
  fireEvent.click(card);
  expect(onSelect).toHaveBeenCalledOnce();
  await hold(screen.getByRole('button',{name:/^시리즈/}));
  expect(onActions).toHaveBeenCalledOnce();
});

it('names the folder in its sheet and offers only what the tablet can do',()=>{
  const onManage=vi.fn(),onClose=vi.fn(),onPin=vi.fn();
  const entries=[folder('p','부모'),folder('c','자식','p')];
  render(<FolderActionSheet folder={entries[0]!} entries={entries} onClose={onClose} onManage={onManage} onPin={onPin}/>);
  const dialog=screen.getByRole('dialog',{name:'부모'});
  expect(within(dialog).getByText('분류 · 30장 · 하위 폴더 1')).toBeTruthy();
  expect(sheetItems(dialog)).toEqual(['고정','하위 폴더 만들기','이름 바꾸기','아이콘 및 색상','닫기']);
  fireEvent.click(within(dialog).getByRole('button',{name:'아이콘 및 색상'}));
  expect(onManage).toHaveBeenCalledWith('look');
  expect(onClose).toHaveBeenCalledOnce();
});

it('pins and unpins from the folder sheet',()=>{
  const onPin=vi.fn();
  const entries=[folder('p','부모')];
  const {rerender}=render(<FolderActionSheet folder={entries[0]!} entries={entries} onClose={()=>{}} onManage={()=>{}} onPin={onPin}/>);
  fireEvent.click(screen.getByRole('button',{name:'고정'}));
  expect(onPin).toHaveBeenCalledOnce();
  rerender(<FolderActionSheet folder={entries[0]!} entries={entries} pinned onClose={()=>{}} onManage={()=>{}} onPin={onPin}/>);
  expect(screen.getByRole('button',{name:'고정 해제'})).toBeTruthy();
});

it('does not offer renaming the protected 오리지널 root',()=>{
  const root=folder('lakomics-originals','오리지널');
  render(<FolderActionSheet folder={root} entries={[root]} onClose={()=>{}} onManage={()=>{}}/>);
  expect(sheetItems(screen.getByRole('dialog',{name:'오리지널'}))).toEqual(['하위 폴더 만들기','아이콘 및 색상','닫기']);
});

it('lists the album actions with 삭제 last and blocks it while the album has sub-albums',()=>{
  const onManage=vi.fn();
  const albums=[album('a','배경 후보'),album('b','세로','a')];
  const view=render(<AlbumActionSheet tree={tree(albums)} album={albums[0]!} onClose={()=>{}} onManage={onManage}/>);
  const dialog=screen.getByRole('dialog',{name:'배경 후보'});
  expect(within(dialog).getByText('앨범 · 7장 · 하위 앨범 1')).toBeTruthy();
  expect(sheetItems(dialog)).toEqual(['하위 앨범 만들기','이름 바꾸기','아이콘 및 색상','삭제 — 하위 앨범 있음','닫기']);
  expect(within(dialog).getByRole('button',{name:'삭제 — 하위 앨범 있음'}).hasAttribute('disabled')).toBe(true);
  fireEvent.click(within(dialog).getByRole('button',{name:'아이콘 및 색상'}));
  expect(onManage).toHaveBeenCalledWith('look');
  view.unmount();
  render(<AlbumActionSheet tree={tree([albums[1]!])} album={albums[1]!} onClose={()=>{}} onManage={onManage}/>);
  fireEvent.click(within(screen.getByRole('dialog',{name:'세로'})).getByRole('button',{name:'삭제'}));
  expect(onManage).toHaveBeenLastCalledWith('delete');
});

it('opens an album\'s sheet on a long press and goes straight to the rename form',async()=>{
  const onSelect=vi.fn();
  render(<Albums tree={tree([album('a','배경 후보')])} paused revision={1} onSelect={onSelect}/>);
  await hold(screen.getByRole('button',{name:'배경 후보, 7개'}));
  fireEvent.click(await screen.findByRole('button',{name:'이름 바꾸기'}));
  const field=await screen.findByLabelText('앨범 이름') as HTMLInputElement;
  expect(field.value).toBe('배경 후보');
  expect(onSelect).not.toHaveBeenCalled();
});

it('lets a work on the shelf ask for its sheet by a long press and keeps the tap for picking it',async()=>{
  const onTap=vi.fn(),onActions=vi.fn();
  render(<ShelfTile item={work()} revision="1" active privacy={false} picked={false} onTap={onTap} onActions={onActions}/>);
  const tile=screen.getByRole('button',{name:'엘든 링'});
  await hold(tile);
  expect(onActions).toHaveBeenCalledWith('w1');
  fireEvent.click(tile);
  expect(onTap).not.toHaveBeenCalled();
  fireEvent.click(tile);
  expect(onTap).toHaveBeenCalledWith('w1');
});

it('shows a work\'s sheet with 휴지통으로 last and runs the chosen item',()=>{
  const handlers={onEdit:vi.fn(),onShowcase:vi.fn(),onTrash:vi.fn(),onClose:vi.fn()};
  render(<CollectionActionSheet work={work()} revision="1" privacy={false} showcase={false} canEdit canShowcase {...handlers}/>);
  const dialog=screen.getByRole('dialog',{name:'엘든 링'});
  expect(within(dialog).getByText('게임 · FromSoftware · 2022')).toBeTruthy();
  expect(sheetItems(dialog)).toEqual(['편집','쇼케이스에 추가','휴지통으로','닫기']);
  fireEvent.click(within(dialog).getByRole('button',{name:'휴지통으로'}));
  expect(handlers.onTrash).toHaveBeenCalledOnce();
  expect(handlers.onClose).toHaveBeenCalledOnce();
});

it('offers the showcase toggle in its current direction and hides what the tablet cannot write yet',()=>{
  const none={onEdit:vi.fn(),onShowcase:vi.fn(),onTrash:vi.fn(),onClose:vi.fn()};
  render(<CollectionActionSheet work={work({showcase:true})} revision="1" privacy={false} showcase canEdit={false} canShowcase {...none}/>);
  const dialog=screen.getByRole('dialog',{name:'엘든 링'});
  expect(sheetItems(dialog)).toEqual(['쇼케이스에서 빼기','닫기']);
  fireEvent.click(within(dialog).getByRole('button',{name:'쇼케이스에서 빼기'}));
  expect(none.onShowcase).toHaveBeenCalledOnce();
});

it('queues the artist edits from the sheet and closes it, without offering to merge',()=>{
  const onClose=vi.fn();
  render(<ArtistActionSheet artist={artist({hidden:true})} endpoint="https://example.invalid" onClose={onClose}/>);
  const dialog=screen.getByRole('dialog',{name:'mizuiro'});
  expect(within(dialog).getByText('작가 · 251장')).toBeTruthy();
  expect(sheetItems(dialog)).toEqual(['고정','이름 바꾸기','숨김 해제','닫기']);
  fireEvent.click(within(dialog).getByRole('button',{name:'고정'}));
  expect(mocks.commit).toHaveBeenCalledWith('https://example.invalid',expect.objectContaining({id:'ar1'}),'pin',undefined);
  expect(onClose).toHaveBeenCalledOnce();
});

it('keeps the artist sheet open and says why when an edit cannot be queued',()=>{
  mocks.commit.mockImplementation(()=>{throw new Error('저장 공간을 확인해 주세요.');});
  const onClose=vi.fn();
  render(<ArtistActionSheet artist={artist()} endpoint="https://example.invalid" onClose={onClose}/>);
  fireEvent.click(screen.getByRole('button',{name:'숨기기'}));
  expect(screen.getByRole('alert').textContent).toBe('저장 공간을 확인해 주세요.');
  expect(onClose).not.toHaveBeenCalled();
});

it('renames an artist from the sheet',async()=>{
  const onClose=vi.fn();
  render(<ArtistActionSheet artist={artist({displayName:'옛 이름'})} endpoint="https://example.invalid" onClose={onClose}/>);
  fireEvent.click(screen.getByRole('button',{name:'이름 바꾸기'}));
  const field=await screen.findByLabelText('작가 이름') as HTMLInputElement;
  expect(field.value).toBe('옛 이름');
  fireEvent.change(field,{target:{value:'새 이름'}});
  fireEvent.click(screen.getByRole('button',{name:'저장'}));
  expect(mocks.commit).toHaveBeenCalledWith('https://example.invalid',expect.objectContaining({id:'ar1'}),'rename','새 이름');
  expect(onClose).toHaveBeenCalledOnce();
});

const imageSheet=(over:Partial<Parameters<typeof ImageActionSheet>[0]>={})=>{
  const props={assets:[image('a',{source_url:'https://x.example/1'}),image('b',{source_url:'https://x.example/1'})],count:2,scopeName:'하우징',busy:false,albumCount:3,inAlbum:false,
    onAlbum:vi.fn(),onRemoveFromAlbum:vi.fn(),onInfo:undefined,onTrash:vi.fn(),onClose:vi.fn(),...over};
  render(<ImageActionSheet {...props}/>);
  return {props,dialog:screen.getByRole('dialog',{name:`${props.count}개 선택`})};
};

it('names the selection and lists the image actions with 휴지통으로 last',()=>{
  const {props,dialog}=imageSheet();
  expect(within(dialog).getByText('하우징')).toBeTruthy();
  expect(sheetItems(dialog)).toEqual(['출처 복사','앨범에 추가','휴지통으로','닫기']);
  fireEvent.click(within(dialog).getByRole('button',{name:'앨범에 추가'}));
  expect(props.onAlbum).toHaveBeenCalledOnce();
  expect(props.onClose).toHaveBeenCalledOnce();
});

it('copies the sources once and stays open to say so',async()=>{
  const writeText=vi.fn(async()=>undefined);
  vi.stubGlobal('navigator',{...navigator,clipboard:{writeText}});
  const {props,dialog}=imageSheet();
  fireEvent.click(within(dialog).getByRole('button',{name:'출처 복사'}));
  await waitFor(()=>expect(screen.getByRole('status').textContent).toBe('출처를 복사했습니다.'));
  expect(writeText).toHaveBeenCalledWith('https://x.example/1');
  expect(props.onClose).not.toHaveBeenCalled();
});

it('offers 정보 열기 and 이 앨범에서 빼기 only where they apply, and no trash where there is none',()=>{
  const {dialog}=imageSheet({count:1,inAlbum:true,onInfo:vi.fn(),onTrash:undefined,assets:[image('a')]});
  expect(sheetItems(dialog)).toEqual(['출처 복사','앨범에 추가','이 앨범에서 빼기','정보 열기','닫기']);
  expect(within(dialog).getByRole('button',{name:'출처 복사'}).hasAttribute('disabled')).toBe(true);
});
