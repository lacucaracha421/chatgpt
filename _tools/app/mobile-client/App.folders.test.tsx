import type {ReactNode} from 'react';
import {act,cleanup,fireEvent,render,screen,waitFor,within} from '@testing-library/react';
import {afterEach,beforeEach,describe,expect,it,vi} from 'vitest';
import type {Asset} from './types';
import type {HomeProps} from './Home';
const mocks=vi.hoisted(()=>({api:vi.fn(),native:vi.fn()}));
vi.mock('./transport',()=>({api:mocks.api,native:mocks.native,errorText:(reason:unknown)=>reason instanceof Error?reason.message:'connection failed',
  ApiError:class ApiError extends Error{status:number|null;details:unknown;constructor(message:string,status:number|null,details:unknown){super(message);this.status=status;this.details=details;}}}));
vi.mock('./media',()=>({clearMediaCache:vi.fn(),loadThumbnail:vi.fn(async(a)=>a),prepareAssets:()=>new Promise(()=>{})}));
vi.mock('./Home',()=>({Home:({items,onOpen}:HomeProps)=><div>{items.slice(0,12).map((a,i)=><button key={a.id} onClick={()=>onOpen(i)}>{`tile-${a.id}`}</button>)}</div>}));
vi.mock('./Gallery',()=>({Gallery:({intro,items,onOpen,onNearEnd,identity,scrubberSort}:{intro?:ReactNode;items:Asset[];onOpen(i:number):void;onNearEnd():void;identity:string;scrubberSort?:{kind:string}})=><div className="gallery-scroll" aria-label="자산 목록" data-identity={identity} data-scrubber={scrubberSort?.kind}><div className="gallery-intro">{intro}</div><div className="gallery-canvas">{items.map((a,i)=><button key={a.id} onClick={()=>onOpen(i)}>{`tile-${a.id}`}</button>)}</div><button data-testid="near-end" onClick={onNearEnd}>near end</button></div>}));
vi.mock('./Viewer',()=>({Viewer:({items,index}:{items:Asset[];index:number})=><div>{`viewer-${items[index].id}`}</div>}));
import {App} from './App';

const AUTHORITY={libraryId:'a'.repeat(32),epoch:1,contractVersion:1};
const page=(ids:string[],over:Record<string,unknown>={})=>({items:ids.map(id=>({id,kind:'image',width:100,height:100})),has_more:false,next_cursor:null,filterVersion:1,...over});
const assetPaths=()=>mocks.api.mock.calls.map(call=>String(call[0])).filter(path=>path.startsWith('/v1/library/assets'));
const lastPagePath=()=>assetPaths().filter(path=>!path.includes('limit=3&')&&!path.includes('&limit=3')).at(-1)!;
const params=(path:string)=>new URL(path,'https://example.invalid').searchParams;
const folderList=(version:number|undefined,authority:unknown=AUTHORITY)=>({
  items:[
    {id:'p',name:'부모',asset_count:2,parent_id:null,...(version?{total_asset_count:9}:{})},
    {id:'c',name:'자식',asset_count:3,parent_id:'p',...(version?{total_asset_count:3}:{})},
    {id:'q',name:'혼자',asset_count:4,parent_id:null,...(version?{total_asset_count:4}:{})},
  ],
  ...(version?{listVersion:version}:{}),...(version&&authority?{authority}:{}),
});
/** A server at the given list version; `apply` is what the page route echoes back as applied. */
const server=(version:number|undefined,{authority=AUTHORITY,echo=true}:{authority?:unknown;echo?:boolean}={})=>async(path:string)=>{
  if(path==='/v1/library/list-generation')return{generation:'a'.repeat(64),filterVersion:1};
  if(path.startsWith('/v1/library/classifications'))return folderList(version,authority);
  if(path.includes('revisit'))return{bundles:[]};if(path.includes('captures'))return{captures:[]};
  if(path.startsWith('/v1/library/assets')){
    const query=params(path);
    const applied={...(echo&&query.get('subtree')==='1'?{subtree:1}:{}),...(echo&&['favorites','random'].includes(query.get('sort')??'')?{sort:query.get('sort')}:{})};
    const ids=query.get('subtree')==='1'?['s1','s2','s3']:query.get('sort')==='random'?['r1','r2']:query.get('classification_id')==='p'?['p1']:['a1'];
    return page(ids,{searchFilters:applied});
  }
  return page(['a1']);
};
beforeEach(()=>{
  vi.stubGlobal('ResizeObserver',class{observe(){}disconnect(){}});
  localStorage.clear();mocks.api.mockReset();mocks.native.mockReset();
  mocks.native.mockResolvedValue({configured:true,endpoint:'https://example.invalid'});
  mocks.api.mockImplementation(server(2));
});
afterEach(()=>{cleanup();vi.unstubAllGlobals();});
const openAll=async()=>{fireEvent.click(await screen.findByRole('button',{name:/모든 자산/}));await screen.findByText('tile-a1');};
const openFolder=async(name:RegExp)=>{fireEvent.click(await screen.findByRole('button',{name}));await screen.findByText('tile-p1');};
const sortOptions=()=>within(screen.getByRole('radiogroup',{name:'정렬'})).getAllByRole('radio').map(option=>option.textContent);

describe('folder list request',()=>{
  it('asks for the subtree counts and shows a folder card\'s whole subtree',async()=>{
    render(<App/>);
    const card=await screen.findByRole('button',{name:/^부모/});
    expect(card.getAttribute('aria-label')).toBe('부모, 9개');
    expect(mocks.api.mock.calls.some(call=>call[0]==='/v1/library/classifications?subtree_counts=1')).toBe(true);
    expect((await screen.findByRole('button',{name:/^혼자/})).getAttribute('aria-label')).toBe('혼자, 4개');
  });
  it('keeps the direct count on a server that predates subtree counts',async()=>{
    mocks.api.mockImplementation(server(undefined));
    render(<App/>);
    expect((await screen.findByRole('button',{name:/^부모/})).getAttribute('aria-label')).toBe('부모, 2개');
  });
  it('asks for covers from anywhere below a folder only when the server serves subtree listings',async()=>{
    render(<App/>);
    await screen.findByRole('button',{name:/^부모/});
    await waitFor(()=>expect(assetPaths().some(path=>path.includes('classification_id=p')&&path.includes('subtree=1')&&path.includes('limit=3'))).toBe(true));
    mocks.api.mockClear();cleanup();
    mocks.api.mockImplementation(server(undefined));
    render(<App/>);
    await screen.findByRole('button',{name:/^부모/});
    await waitFor(()=>expect(assetPaths().some(path=>path.includes('classification_id=p')&&path.includes('limit=3'))).toBe(true));
    expect(assetPaths().some(path=>path.includes('subtree=1'))).toBe(false);
  });
});

describe('sorting a list',()=>{
  it('offers the two shipped sorts only, to a server without list version 2',async()=>{
    mocks.api.mockImplementation(server(undefined));
    render(<App/>);await openAll();
    fireEvent.click(screen.getByRole('button',{name:/^정렬/}));
    expect(sortOptions()).toEqual(['최신순','오래된순']);
    expect(screen.queryByRole('button',{name:'다시 섞기'})).toBeNull();
  });
  it('offers 좋아요순 and 랜덤 from list version 2, and asks the server for them',async()=>{
    render(<App/>);await openAll();
    fireEvent.click(screen.getByRole('button',{name:/^정렬/}));
    expect(sortOptions()).toEqual(['최신순','오래된순','좋아요순','랜덤']);
    fireEvent.click(screen.getByRole('radio',{name:'좋아요순'}));
    await waitFor(()=>expect(params(lastPagePath()).get('sort')).toBe('favorites'));
    expect(params(lastPagePath()).has('seed')).toBe(false);
    expect(screen.getByRole('button',{name:'정렬 좋아요순'})).toBeTruthy();
  });
  it('shuffles with a seed, keeps the seed while paging, and reshuffles with a new one',async()=>{
    render(<App/>);await openAll();
    fireEvent.click(screen.getByRole('button',{name:/^정렬/}));
    fireEvent.click(screen.getByRole('radio',{name:'랜덤'}));
    await screen.findByText('tile-r1');
    const first=params(lastPagePath());
    expect(first.get('sort')).toBe('random');expect(first.get('seed')).toMatch(/^[0-9a-f]{32}$/);
    const gallery=screen.getByLabelText('자산 목록');
    expect(gallery.getAttribute('data-scrubber')).toBe('fallback');
    const identity=gallery.getAttribute('data-identity');
    // Choosing 랜덤 again keeps the same shuffle.
    fireEvent.click(screen.getByRole('button',{name:/^정렬/}));
    fireEvent.click(screen.getByRole('radio',{name:'랜덤'}));
    expect(screen.getByLabelText('자산 목록').getAttribute('data-identity')).toBe(identity);
    expect(screen.queryByRole('dialog',{name:'정렬'})).toBeNull();
    // 다시 섞기 is a new seed, hence a new list identity and no cursor.
    fireEvent.click(screen.getByRole('button',{name:/^정렬/}));
    fireEvent.click(screen.getByRole('button',{name:'다시 섞기'}));
    await waitFor(()=>expect(params(lastPagePath()).get('seed')).not.toBe(first.get('seed')));
    const second=params(lastPagePath());
    expect(second.get('sort')).toBe('random');expect(second.get('seed')).toMatch(/^[0-9a-f]{32}$/);expect(second.has('cursor')).toBe(false);
    await waitFor(()=>expect(screen.getByLabelText('자산 목록').getAttribute('data-identity')).not.toBe(identity));
    expect(screen.getByLabelText('자산 목록').getAttribute('data-identity')).toContain(`seed=${second.get('seed')}`);
  });
  it('drops the seed and the shuffle when another sort is chosen',async()=>{
    render(<App/>);await openAll();
    fireEvent.click(screen.getByRole('button',{name:/^정렬/}));fireEvent.click(screen.getByRole('radio',{name:'랜덤'}));await screen.findByText('tile-r1');
    fireEvent.click(screen.getByRole('button',{name:/^정렬/}));fireEvent.click(screen.getByRole('radio',{name:'오래된순'}));
    await waitFor(()=>expect(params(lastPagePath()).get('sort')).toBe('oldest'));
    expect(params(lastPagePath()).has('seed')).toBe(false);
    expect(screen.getByLabelText('자산 목록').getAttribute('data-scrubber')).toBeNull();
  });
  it('requests no month index for a shuffled or favorites list',async()=>{
    render(<App/>);await openAll();
    mocks.api.mockClear();
    fireEvent.click(screen.getByRole('button',{name:/^정렬/}));fireEvent.click(screen.getByRole('radio',{name:'랜덤'}));await screen.findByText('tile-r1');
    expect(assetPaths().some(path=>path.includes('toc=1'))).toBe(false);
  });
  it('refuses a list a server returned without applying the requested sort',async()=>{
    mocks.api.mockImplementation(server(2,{echo:false}));
    render(<App/>);await openAll();
    fireEvent.click(screen.getByRole('button',{name:/^정렬/}));fireEvent.click(screen.getByRole('radio',{name:'랜덤'}));
    expect((await screen.findAllByText('이 서버는 이 정렬을 지원하지 않습니다. 서버를 업데이트해 주세요.')).length).toBeGreaterThan(0);
    // The previous list stays on screen.
    expect(screen.getByText('tile-a1')).toBeTruthy();
  });
});

describe('folder subtree',()=>{
  it('shows the 미분류 / 전체 switch with both counts for a folder that has subfolders',async()=>{
    render(<App/>);await openFolder(/^부모/);
    const scope=screen.getByRole('radiogroup',{name:'이미지 범위'});
    const [direct,all]=within(scope).getAllByRole('radio');
    expect(direct.getAttribute('aria-label')).toBe('미분류 2');expect(all.getAttribute('aria-label')).toBe('전체 9');
    expect(direct.getAttribute('aria-checked')).toBe('true');
    expect(params(lastPagePath()).has('subtree')).toBe(false);
    // The subfolder shelf is there in 미분류.
    expect(screen.getByRole('button',{name:/^자식/})).toBeTruthy();
  });
  it('lists the folder with everything below it in 전체 and hides the shelf, as the PC does',async()=>{
    render(<App/>);await openFolder(/^부모/);
    const direct=screen.getByLabelText('자산 목록').getAttribute('data-identity');
    fireEvent.click(within(screen.getByRole('radiogroup',{name:'이미지 범위'})).getByRole('radio',{name:'전체 9'}));
    await screen.findByText('tile-s1');
    const query=params(lastPagePath());
    expect(query.get('subtree')).toBe('1');expect(query.getAll('classification_id')).toEqual(['p']);expect(query.has('cursor')).toBe(false);
    expect(screen.getByLabelText('자산 목록').getAttribute('data-identity')).not.toBe(direct);
    expect(screen.queryByRole('button',{name:/^자식/})).toBeNull();
    expect(within(screen.getByRole('radiogroup',{name:'이미지 범위'})).getByRole('radio',{name:'전체 9'}).getAttribute('aria-checked')).toBe('true');
    // The header count follows the mode.
    expect(document.body.textContent).toContain('9');
    // And back.
    fireEvent.click(within(screen.getByRole('radiogroup',{name:'이미지 범위'})).getByRole('radio',{name:'미분류 2'}));
    await screen.findByText('tile-p1');
    expect(params(lastPagePath()).has('subtree')).toBe(false);
    expect(screen.getByRole('button',{name:/^자식/})).toBeTruthy();
  });
  it('keeps the sort, the shuffle and the kind when the range changes',async()=>{
    render(<App/>);await openFolder(/^부모/);
    fireEvent.click(screen.getByRole('button',{name:/^정렬/}));fireEvent.click(screen.getByRole('radio',{name:'랜덤'}));await screen.findByText('tile-r1');
    const seed=params(lastPagePath()).get('seed');
    fireEvent.click(within(screen.getByRole('radiogroup',{name:'이미지 범위'})).getByRole('radio',{name:'전체 9'}));
    await waitFor(()=>expect(params(lastPagePath()).get('subtree')).toBe('1'));
    expect(params(lastPagePath()).get('sort')).toBe('random');expect(params(lastPagePath()).get('seed')).toBe(seed);
  });
  it('does not offer the switch for a folder without subfolders or on a server without list version 2',async()=>{
    render(<App/>);
    fireEvent.click(await screen.findByRole('button',{name:/^혼자/}));await screen.findByText('tile-a1');
    expect(screen.queryByRole('radiogroup',{name:'이미지 범위'})).toBeNull();
    cleanup();mocks.api.mockImplementation(server(undefined));
    render(<App/>);await openFolder(/^부모/);
    expect(screen.queryByRole('radiogroup',{name:'이미지 범위'})).toBeNull();
  });
  it('refuses a list a server returned without applying the subtree mode',async()=>{
    mocks.api.mockImplementation(server(2,{echo:false}));
    render(<App/>);await openFolder(/^부모/);
    fireEvent.click(within(screen.getByRole('radiogroup',{name:'이미지 범위'})).getByRole('radio',{name:'전체 9'}));
    expect((await screen.findAllByText('이 서버는 하위 폴더까지 보기를 지원하지 않습니다. 서버를 업데이트해 주세요.')).length).toBeGreaterThan(0);
    expect(screen.getByText('tile-p1')).toBeTruthy();
  });
});

describe('folder management entry points',()=>{
  it('offers 새 폴더 and 폴더 관리 only when the server declares the authority identity',async()=>{
    render(<App/>);
    expect(await screen.findByRole('button',{name:'새 폴더'})).toBeTruthy();
    fireEvent.click(await screen.findByRole('button',{name:/^혼자/}));await screen.findByText('tile-a1');
    expect(screen.getByRole('button',{name:'폴더 관리'})).toBeTruthy();
    cleanup();mocks.api.mockImplementation(server(2,{authority:null}));
    render(<App/>);
    await screen.findByRole('button',{name:/^혼자/});
    expect(screen.queryByRole('button',{name:'새 폴더'})).toBeNull();
    fireEvent.click(screen.getByRole('button',{name:/^혼자/}));await screen.findByText('tile-a1');
    expect(screen.queryByRole('button',{name:'폴더 관리'})).toBeNull();
  });
  it('creates a folder from the library root and shows it straight away',async()=>{
    // The server's own list includes the new folder once the command is accepted.
    const created:Record<string,unknown>[]=[];
    mocks.api.mockImplementation(async(path:string,signal:unknown,body:Record<string,unknown>)=>{
      if(path==='/v1/classifications/authority/commands'){
        const folder={id:body.classificationId,kind:'root',name:body.name,parentId:null,iconKey:null,colorKey:null,deleted:false,entityRevision:1};
        created.push({id:folder.id,name:folder.name,asset_count:0,total_asset_count:0,parent_id:null});
        return{classification:folder};
      }
      if(path.startsWith('/v1/library/classifications'))return{...folderList(2),items:[...folderList(2).items,...created]};
      return server(2)(path);
    });
    render(<App/>);
    fireEvent.click(await screen.findByRole('button',{name:'새 폴더'}));
    fireEvent.change(await screen.findByLabelText('폴더 이름'),{target:{value:'새로 만든'}});
    await act(async()=>fireEvent.click(screen.getByRole('button',{name:'만들기'})));
    expect((await screen.findByRole('button',{name:/^새로 만든/})).getAttribute('aria-label')).toBe('새로 만든, 0개');
    const command=mocks.api.mock.calls.find(call=>call[0]==='/v1/classifications/authority/commands')!;
    expect(command[2]).toMatchObject({commandType:'createClassification',kind:'root',parentId:null,name:'새로 만든',epoch:1});
    expect(command[3]).toBe('PUT');
    // The list is read again, and the folder is still there.
    await waitFor(()=>expect(mocks.api.mock.calls.filter(call=>call[0]==='/v1/library/classifications?subtree_counts=1').length).toBeGreaterThan(1));
    expect(screen.getByRole('button',{name:/^새로 만든/})).toBeTruthy();
  });
  it('renames the open folder and the title follows',async()=>{
    let name='혼자';
    mocks.api.mockImplementation(async(path:string,signal:unknown,body:Record<string,unknown>)=>{
      if(path.includes('/classifications/authority/baseline'))return{libraryId:AUTHORITY.libraryId,epoch:1,snapshotCursor:5,section:'classifications',hasMore:false,nextAfter:null,
        items:[{id:'q',kind:'root',name,parentId:null,iconKey:null,colorKey:null,deleted:false,entityRevision:3}]};
      if(path==='/v1/classifications/authority/commands'){name=String(body.name);return{classification:{id:'q',kind:'root',name,parentId:null,iconKey:null,colorKey:null,deleted:false,entityRevision:4}};}
      if(path.startsWith('/v1/library/classifications'))return{...folderList(2),items:folderList(2).items.map(item=>item.id==='q'?{...item,name}:item)};
      return server(2)(path);
    });
    render(<App/>);
    fireEvent.click(await screen.findByRole('button',{name:/^혼자/}));await screen.findByText('tile-a1');
    fireEvent.click(screen.getByRole('button',{name:'폴더 관리'}));
    await waitFor(()=>expect((screen.getByRole('button',{name:'이름 바꾸기'}) as HTMLButtonElement).disabled).toBe(false));
    fireEvent.click(screen.getByRole('button',{name:'이름 바꾸기'}));
    fireEvent.change(screen.getByLabelText('폴더 이름'),{target:{value:'바뀐 이름'}});
    await act(async()=>fireEvent.click(screen.getByRole('button',{name:'저장'})));
    await waitFor(()=>expect(screen.getByRole('heading',{level:1}).textContent).toBe('바뀐 이름'));
    const command=mocks.api.mock.calls.find(call=>call[0]==='/v1/classifications/authority/commands')!;
    expect(command[2]).toMatchObject({commandType:'renameClassification',classificationId:'q',name:'바뀐 이름',expectedRevision:3});
    // And it stays renamed after the folder list is read again.
    await waitFor(()=>expect(mocks.api.mock.calls.filter(call=>call[0]==='/v1/library/classifications?subtree_counts=1').length).toBeGreaterThan(1));
    expect(screen.getByRole('heading',{level:1}).textContent).toBe('바뀐 이름');
  });
});
