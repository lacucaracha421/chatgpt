import {cleanup, fireEvent, render, screen, waitFor} from '@testing-library/react';
import {afterEach, beforeEach, describe, expect, it, vi} from 'vitest';
const mocks=vi.hoisted(()=>({api:vi.fn(),native:vi.fn()}));
vi.mock('./transport',()=>({api:mocks.api,native:mocks.native,errorText:(reason:unknown)=>String(reason)}));
vi.mock('./media',()=>({mediaTicket:vi.fn(),loadThumbnail:()=>new Promise(()=>{})}));
// The virtualized Gallery has its own check; this file is about the scope's query contract.
vi.mock('./Gallery',()=>({Gallery:({items,onNearEnd,identity}:{items:{id:string}[];onNearEnd():void;identity:string})=><div className="gallery-scroll" data-identity={identity}><ul>{items.map(item=><li key={item.id}>{item.id}</li>)}</ul><button data-testid="near-end" onClick={onNearEnd}>near end</button></div>}));
import {Albums} from './Albums';
import type {AlbumTree,NativeAlbum} from './Albums';
import {CharacterBrowser} from './CharacterBrowser';
import {characterPath} from './characterModel';
import type {CharacterIndex} from './characterModel';

const albums:NativeAlbum[]=[{id:'root',name:'업로드용',parentId:null,iconKey:null,colorKey:null}];
const adopted:AlbumTree={adopted:true,libraryId:'a'.repeat(32),epoch:1,code:'',albums};
const asset=(id:string,over:Record<string,unknown>={})=>({id,kind:'image',content_type:'image/png',size_bytes:10,thumbnail_available:true,...over});
const revision='a'.repeat(64);
const index:CharacterIndex={version:1,authority:'pc',authorityEpoch:0,capabilities:{read:true,write:false},ready:true,revision,publishedAt:null,nodes:[{id:'series:s',kind:'series',sourceId:'s',seriesId:'s',parentId:null,name:'Series',description:'',thumbnailAssetId:null,manualOnly:false,excluded:false}],scopes:[{nodeId:'series:s',filter:'all',totalCount:2,sourceCount:2}]};

beforeEach(()=>{vi.stubGlobal('ResizeObserver',class{observe(){}disconnect(){}});vi.stubGlobal('matchMedia',()=>({matches:false,addEventListener(){},removeEventListener(){}}));mocks.api.mockReset();mocks.native.mockReset();});
afterEach(()=>{cleanup();vi.unstubAllGlobals();});

describe('album scope filters',()=>{
  it('keeps a failed filter choice from relabelling the unfiltered page, and blocks an append under the mismatch',async()=>{
    mocks.native.mockResolvedValue(adopted);
    let filtered=0;
    mocks.api.mockImplementation(async(path:string)=>{
      if(path.includes('/v1/albums/assets')&&path.includes('media_kind')){filtered++;throw new Error('narrowing failed');}
      if(path.includes('/v1/albums/assets'))return{filterVersion:1,items:[asset('a1')],hasMore:true,nextCursor:'c1'};
      return{items:[]};
    });
    render(<Albums active paused={false} onOpen={()=>{}} backRef={{current:null}}/>);
    fireEvent.click(await screen.findByText('업로드용'));
    await screen.findByText('a1');
    // The initial unfiltered page is committed and offers a continuation.
    expect(screen.queryByText('영상')).toBeNull();
    fireEvent.click(screen.getByRole('button',{name:'자산 필터'}));
    fireEvent.click([...screen.getByRole('group',{name:'미디어'}).querySelectorAll('button')].find(b=>b.textContent==='영상')!);
    await waitFor(()=>expect(filtered).toBe(1));
    await waitFor(()=>expect(screen.getAllByText(/narrowing failed/).length).toBeGreaterThan(0));
    // The unfiltered page is still what is shown, and its identity still describes it.
    const gallery=document.querySelector('.gallery-scroll')!;
    expect(gallery.getAttribute('data-identity')).not.toContain('media_kind');
    expect(screen.getByText('a1')).toBeTruthy();
    // An append must not extend that page's cursor with the filters that failed to apply.
    fireEvent.click(screen.getByTestId('near-end'));
    await new Promise(resolve=>setTimeout(resolve,20));
    expect(mocks.api.mock.calls.filter(call=>String(call[0]).includes('cursor=c1'))).toHaveLength(0);
  });

  it('aborts an in-flight append when the filter changes, so its rows cannot land in the new result set',async()=>{
    mocks.native.mockResolvedValue(adopted);
    let releaseAppend:(value:unknown)=>void=()=>{};
    const appended=new Promise(resolve=>{releaseAppend=resolve;});
    mocks.api.mockImplementation(async(path:string,signal?:AbortSignal)=>{
      if(path.includes('cursor=c1'))return appended;
      if(path.includes('/v1/albums/assets')&&path.includes('media_kind'))return{filterVersion:1,items:[asset('new1')],hasMore:false,nextCursor:null};
      if(path.includes('/v1/albums/assets'))return{filterVersion:1,items:[asset('a1')],hasMore:true,nextCursor:'c1'};
      return{items:[]};
    });
    render(<Albums active paused={false} onOpen={()=>{}} backRef={{current:null}}/>);
    fireEvent.click(await screen.findByText('업로드용'));
    await screen.findByText('a1');
    fireEvent.click(screen.getByTestId('near-end'));
    // Change the filter while the continuation is still outstanding.
    fireEvent.click(screen.getByRole('button',{name:'자산 필터'}));
    fireEvent.click([...screen.getByRole('group',{name:'미디어'}).querySelectorAll('button')].find(b=>b.textContent==='영상')!);
    await screen.findByText('new1');
    // The late continuation resolves after the replacement; its rows must not appear.
    releaseAppend({filterVersion:1,items:[asset('stale1'),asset('stale2')],hasMore:false,nextCursor:null});
    await new Promise(resolve=>setTimeout(resolve,20));
    expect(screen.queryByText('stale1')).toBeNull();
    expect(screen.queryByText('stale2')).toBeNull();
    expect(screen.getByText('new1')).toBeTruthy();
  });

  it('validates the contract on every appended page, not only the first',async()=>{
    mocks.native.mockResolvedValue(adopted);
    mocks.api.mockImplementation(async(path:string)=>{
      if(path.includes('cursor=c1'))return{items:[asset('unchecked1')],hasMore:false,nextCursor:null};
      if(path.includes('/v1/albums/assets')&&path.includes('media_kind'))return{filterVersion:1,items:[asset('a1')],hasMore:true,nextCursor:'c1'};
      if(path.includes('/v1/albums/assets'))return{filterVersion:1,items:[asset('a1')],hasMore:false,nextCursor:null};
      return{items:[]};
    });
    render(<Albums active paused={false} onOpen={()=>{}} backRef={{current:null}}/>);
    fireEvent.click(await screen.findByText('업로드용'));
    await screen.findByText('a1');
    fireEvent.click(screen.getByRole('button',{name:'자산 필터'}));
    fireEvent.click([...screen.getByRole('group',{name:'미디어'}).querySelectorAll('button')].find(b=>b.textContent==='영상')!);
    await waitFor(()=>expect(String(mocks.api.mock.calls.at(-1)?.[0])).toContain('media_kind=videos'));
    fireEvent.click(screen.getByTestId('near-end'));
    // The contract-less continuation is refused rather than spliced into the filtered list.
    await waitFor(()=>expect(screen.getAllByText(/서버를 업데이트해 주세요/).length).toBeGreaterThan(0));
    expect(screen.queryByText('unchecked1')).toBeNull();
  });

  it('closes the nested filter dialog on Back before the album itself',async()=>{
    mocks.native.mockResolvedValue(adopted);
    mocks.api.mockImplementation(async(path:string)=>path.includes('/v1/albums/assets')?{filterVersion:1,items:[asset('a1')],hasMore:false,nextCursor:null}:{items:[]});
    const back={current:null as (()=>boolean)|null};
    render(<Albums active paused={false} onOpen={()=>{}} backRef={back}/>);
    fireEvent.click(await screen.findByText('업로드용'));
    await screen.findByText('a1');
    fireEvent.click(screen.getByRole('button',{name:'자산 필터'}));
    expect(screen.getByRole('dialog',{name:'자산 필터'})).toBeTruthy();
    // First press closes the inner surface and is consumed.
    expect(back.current?.()).toBe(true);
    await waitFor(()=>expect(screen.queryByRole('dialog',{name:'자산 필터'})).toBeNull());
    // The album dialog is still open, so a second press is needed to leave it.
    expect(screen.getByRole('dialog',{name:'업로드용'})).toBeTruthy();
    expect(back.current?.()).toBe(true);
    await waitFor(()=>expect(screen.queryByRole('dialog',{name:'업로드용'})).toBeNull());
  });

  it('refuses a cached page that does not carry the filter contract',async()=>{
    mocks.native.mockResolvedValue(adopted);
    let calls=0;
    mocks.api.mockImplementation(async(path:string)=>{
      if(path.includes('/v1/albums/assets')&&path.includes('media_kind')){
        calls++;
        // The first narrowed read is contract-less and must be refused, and the second is
        // the retry, which succeeds.
        return calls===1?{items:[asset('a1')],hasMore:false,nextCursor:null}:{filterVersion:1,items:[asset('refused1')],hasMore:false,nextCursor:null};
      }
      if(path.includes('/v1/albums/assets'))return{filterVersion:1,items:[asset('a1')],hasMore:false,nextCursor:null};
      return{items:[]};
    });
    render(<Albums active paused={false} onOpen={()=>{}} backRef={{current:null}}/>);
    fireEvent.click(await screen.findByText('업로드용'));
    await screen.findByText('a1');
    fireEvent.click(screen.getByRole('button',{name:'자산 필터'}));
    fireEvent.click([...screen.getByRole('group',{name:'미디어'}).querySelectorAll('button')].find(b=>b.textContent==='영상')!);
    await waitFor(()=>expect(screen.getAllByText(/서버를 업데이트해 주세요/).length).toBeGreaterThan(0));
    // Retry repeats the attempted choice and now succeeds, replacing the visible page. Only
    // the album body's own retry is live here: the closing filter dialog still holds one.
    const live=[...document.querySelectorAll('.inline-error button')].filter(b=>b.textContent==='다시 시도'&&!b.closest('[data-aria-hidden="true"]'));
    expect(live.length).toBeGreaterThan(0);
    fireEvent.click(live[0]);
    await waitFor(()=>expect(screen.getByText('refused1')).toBeTruthy());
    expect(calls).toBe(2);
  });
  it('sends the filter parameters on the album contents read and on its continuation',async()=>{
    mocks.native.mockResolvedValue(adopted);
    mocks.api.mockImplementation(async(path:string)=>{
      if(path.includes('/v1/albums/assets'))return{filterVersion:1,items:[asset('a1')],hasMore:path.includes('cursor=c1'),nextCursor:path.includes('cursor=c1')?null:'c1'};
      return{items:[]};
    });
    render(<Albums active paused={false} onOpen={()=>{}} backRef={{current:null}}/>);
    fireEvent.click(await screen.findByText('업로드용'));
    await screen.findByText('a1');
    fireEvent.click(screen.getByRole('button',{name:'자산 필터'}));
    const within=screen.getByRole('group',{name:'미디어'});
    fireEvent.click([...within.querySelectorAll('button')].find(b=>b.textContent==='영상')!);
    await waitFor(()=>expect(String(mocks.api.mock.calls.at(-1)?.[0])).toContain('media_kind=videos'));
    // The album identity is preserved alongside the new parameters.
    const path=String(mocks.api.mock.calls.at(-1)?.[0]);
    expect(path).toContain(`libraryId=${'a'.repeat(32)}`);
    expect(path).toContain('albumId=root');
  });

  it('refuses an album page that ignored the filter parameters',async()=>{
    mocks.native.mockResolvedValue(adopted);
    mocks.api.mockImplementation(async(path:string)=>{
      if(path.includes('/v1/albums/assets')&&path.includes('aspect_ratio'))return{items:[asset('a1')],hasMore:false,nextCursor:null};
      if(path.includes('/v1/albums/assets'))return{filterVersion:1,items:[asset('a1')],hasMore:false,nextCursor:null};
      return{items:[]};
    });
    render(<Albums active paused={false} onOpen={()=>{}} backRef={{current:null}}/>);
    fireEvent.click(await screen.findByText('업로드용'));
    await screen.findByText('a1');
    fireEvent.click(screen.getByRole('button',{name:'자산 필터'}));
    const within=screen.getByRole('group',{name:'비율'});
    fireEvent.click([...within.querySelectorAll('button')].find(b=>b.textContent==='정사각형')!);
    // The unversioned reply is reported rather than shown as a filtered album.
    await waitFor(()=>expect(screen.getAllByText(/서버를 업데이트해 주세요/).length).toBeGreaterThan(0));
  });

  it('starts each album unfiltered so one album narrowing never leaks into another',async()=>{
    mocks.native.mockResolvedValue({...adopted,albums:[...albums,{id:'other',name:'다른앨범',parentId:null,iconKey:null,colorKey:null}]});
    mocks.api.mockImplementation(async(path:string)=>path.includes('/v1/albums/assets')?{filterVersion:1,items:[asset(path.includes('albumId=other')?'b1':'a1')],hasMore:false,nextCursor:null}:{items:[]});
    render(<Albums active paused={false} onOpen={()=>{}} backRef={{current:null}}/>);
    fireEvent.click(await screen.findByText('업로드용'));
    await screen.findByText('a1');
    fireEvent.click(screen.getByRole('button',{name:'자산 필터'}));
    const within=screen.getByRole('group',{name:'미디어'});
    fireEvent.click([...within.querySelectorAll('button')].find(b=>b.textContent==='영상')!);
    await waitFor(()=>expect(String(mocks.api.mock.calls.at(-1)?.[0])).toContain('media_kind=videos'));
    // Opening another album is a different scope, so the filters start clean.
    fireEvent.click(screen.getByRole('button',{name:'앨범 닫기'}));
    fireEvent.click(await screen.findByText('다른앨범'));
    await screen.findByText('b1');
    expect(String(mocks.api.mock.calls.at(-1)?.[0])).not.toContain('media_kind');
  });
});

describe('character scope filters',()=>{
  it('refreshes live technical metadata even when membership revision is unchanged',async()=>{
    let refreshed=false;
    mocks.api.mockImplementation(async(path:string)=>{
      if(path==='/v1/library/characters')return index;
      if(path.startsWith('/v1/library/characters/assets'))return{revision,filterVersion:1,items:[asset(refreshed?'updated':'old')],totalCount:1,sourceCount:2,has_more:false,next_cursor:null};
      return{};
    });
    const props={initialNode:'series:s',active:true,paused:false,density:1,refreshKey:0,onOpen:()=>{},backRef:{current:null},onExit:()=>{}};
    const {rerender}=render(<CharacterBrowser {...props}/>);
    await screen.findByText('old');
    refreshed=true;
    rerender(<CharacterBrowser {...props} refreshKey={1}/>);
    await screen.findByText('updated');
    expect(screen.queryByText('old')).toBeNull();
  });

  it('rejects a snake-case wire contract and closes only the filter dialog on Back',async()=>{
    mocks.api.mockImplementation(async(path:string)=>{
      if(path==='/v1/library/characters')return index;
      if(path.startsWith('/v1/library/characters/assets'))return{revision,filter_version:1,items:[asset('a1')],totalCount:1,sourceCount:2,has_more:false,next_cursor:null};
      return{};
    });
    const back={current:null as (()=>boolean)|null};
    render(<CharacterBrowser initialNode="series:s" active paused={false} density={1} refreshKey={0} onOpen={()=>{}} backRef={back} onExit={()=>{}}/>);
    await screen.findByText('a1');
    fireEvent.click(screen.getByRole('button',{name:'자산 필터'}));
    expect(back.current?.()).toBe(true);
    await waitFor(()=>expect(screen.queryByRole('dialog',{name:'자산 필터'})).toBeNull());
    expect(screen.getByText('a1')).toBeTruthy();
    fireEvent.click(screen.getByRole('button',{name:'자산 필터'}));
    fireEvent.click([...screen.getByRole('group',{name:'미디어'}).querySelectorAll('button')].find(b=>b.textContent==='영상')!);
    await screen.findByText(/서버를 업데이트해 주세요/);
    expect(document.querySelector('.gallery-scroll')!.getAttribute('data-identity')).not.toContain('media_kind');
  });
  it('sends the filter parameters and keeps the frozen scope revision',async()=>{
    mocks.native.mockResolvedValue({configured:true,endpoint:'https://example.invalid'});
    mocks.api.mockImplementation(async(path:string)=>{
      if(path==='/v1/library/characters')return index;
      if(path.startsWith('/v1/library/characters/assets'))return{revision,filterVersion:1,items:[asset('a1')],totalCount:2,sourceCount:2,has_more:false,next_cursor:null};
      return{};
    });
    render(<CharacterBrowser initialNode="series:s" active paused={false} density={1} refreshKey={0} onOpen={()=>{}} backRef={{current:null}} onExit={()=>{}}/>);
    await screen.findByText('Series');
    await screen.findByText('a1');
    fireEvent.click(screen.getByRole('button',{name:'자산 필터'}));
    const within=screen.getByRole('group',{name:'길이'});
    fireEvent.click([...within.querySelectorAll('button')].find(b=>b.textContent==='5분 이상')!);
    await waitFor(()=>expect(String(mocks.api.mock.calls.at(-1)?.[0])).toContain('duration_ms_min=300000'));
    // The frozen membership is still pinned by its revision and node.
    const path=String(mocks.api.mock.calls.at(-1)?.[0]);
    expect(path).toContain(`revision=${revision}`);
    expect(path).toContain('node=series%3As');
  });

  it('refuses a character page that ignored the filter parameters',async()=>{
    mocks.native.mockResolvedValue({configured:true,endpoint:'https://example.invalid'});
    mocks.api.mockImplementation(async(path:string)=>{
      if(path==='/v1/library/characters')return index;
      if(path.startsWith('/v1/library/characters/assets')&&path.includes('media_kind'))return{revision,items:[asset('a1')],totalCount:2,sourceCount:2,has_more:false,next_cursor:null};
      if(path.startsWith('/v1/library/characters/assets'))return{revision,filterVersion:1,items:[asset('a1')],totalCount:2,sourceCount:2,has_more:false,next_cursor:null};
      return{};
    });
    render(<CharacterBrowser initialNode="series:s" active paused={false} density={1} refreshKey={0} onOpen={()=>{}} backRef={{current:null}} onExit={()=>{}}/>);
    await screen.findByText('Series');
    await screen.findByText('a1');
    fireEvent.click(screen.getByRole('button',{name:'자산 필터'}));
    const within=screen.getByRole('group',{name:'미디어'});
    fireEvent.click([...within.querySelectorAll('button')].find(b=>b.textContent==='영상')!);
    await waitFor(()=>expect(screen.getAllByText(/서버를 업데이트해 주세요/).length).toBeGreaterThan(0));
  });

  it('keeps the previous character page when a narrowed load fails, and commits on retry',async()=>{
    mocks.native.mockResolvedValue({configured:true,endpoint:'https://example.invalid'});
    // The first narrowed read fails outright; every later one is a valid narrowed page. The
    // mock is keyed on that, not on a running counter, so a retry cannot accidentally consume
    // the failure twice.
    let failed=false;
    mocks.api.mockImplementation(async(path:string)=>{
      if(path==='/v1/library/characters')return index;
      if(path.startsWith('/v1/library/characters/assets')&&path.includes('media_kind')){
        if(!failed){failed=true;throw new Error('character narrowing failed');}
        return{revision,filterVersion:1,items:[asset('f1')],totalCount:1,sourceCount:2,has_more:false,next_cursor:null};
      }
      if(path.startsWith('/v1/library/characters/assets'))return{revision,filterVersion:1,items:[asset('a1')],totalCount:2,sourceCount:2,has_more:false,next_cursor:null};
      return{};
    });
    render(<CharacterBrowser initialNode="series:s" active paused={false} density={1} refreshKey={0} onOpen={()=>{}} backRef={{current:null}} onExit={()=>{}}/>);
    await screen.findByText('Series');
    await screen.findByText('a1');
    fireEvent.click(screen.getByRole('button',{name:'자산 필터'}));
    fireEvent.click([...screen.getByRole('group',{name:'미디어'}).querySelectorAll('button')].find(b=>b.textContent==='영상')!);
    await waitFor(()=>expect(failed).toBe(true));
    // The failed narrowing does not discard the page already on screen.
    await waitFor(()=>expect(screen.getAllByText(/character narrowing failed/).length).toBeGreaterThan(0));
    expect(screen.getByText('a1')).toBeTruthy();
    // The trigger reports the attempted set, so it is matched by prefix rather than exact name.
    // Choosing the same value again is already the attempt, so it is cleared and re-applied.
    fireEvent.click(screen.getByRole('button',{name:/^자산 필터/}));
    fireEvent.click([...screen.getByRole('group',{name:'미디어'}).querySelectorAll('button')].find(b=>b.textContent==='전체')!);
    await waitFor(()=>expect(screen.queryByText(/character narrowing failed/)).toBeNull());
    expect(screen.getByRole('button',{name:'자산 필터'})).toBeTruthy();
    fireEvent.click(screen.getByRole('button',{name:/^자산 필터/}));
    fireEvent.click([...screen.getByRole('group',{name:'미디어'}).querySelectorAll('button')].find(b=>b.textContent==='영상')!);
    await waitFor(()=>expect(screen.getByText('f1')).toBeTruthy());
    expect(screen.getByRole('button',{name:'자산 필터: 영상'})).toBeTruthy();
  });

  it('refuses a contract-less character continuation instead of splicing it into the filtered scope',async()=>{
    mocks.native.mockResolvedValue({configured:true,endpoint:'https://example.invalid'});
    mocks.api.mockImplementation(async(path:string)=>{
      if(path==='/v1/library/characters')return index;
      if(path.startsWith('/v1/library/characters/assets')&&path.includes('cursor=c1'))return{revision,items:[asset('unchecked1')],totalCount:2,sourceCount:2,has_more:false,next_cursor:null};
      if(path.startsWith('/v1/library/characters/assets')&&path.includes('media_kind'))return{revision,filterVersion:1,items:[asset('a1')],totalCount:2,sourceCount:2,has_more:true,next_cursor:'c1'};
      if(path.startsWith('/v1/library/characters/assets'))return{revision,filterVersion:1,items:[asset('a1')],totalCount:2,sourceCount:2,has_more:false,next_cursor:null};
      return{};
    });
    render(<CharacterBrowser initialNode="series:s" active paused={false} density={1} refreshKey={0} onOpen={()=>{}} backRef={{current:null}} onExit={()=>{}}/>);
    await screen.findByText('Series');
    await screen.findByText('a1');
    fireEvent.click(screen.getByRole('button',{name:'자산 필터'}));
    fireEvent.click([...screen.getByRole('group',{name:'미디어'}).querySelectorAll('button')].find(b=>b.textContent==='영상')!);
    await waitFor(()=>expect(String(mocks.api.mock.calls.at(-1)?.[0])).toContain('media_kind=videos'));
    fireEvent.click(screen.getByTestId('near-end'));
    await waitFor(()=>expect(screen.getAllByText(/서버를 업데이트해 주세요/).length).toBeGreaterThan(0));
    expect(screen.queryByText('unchecked1')).toBeNull();
  });

  it('builds the character path with the filters appended and nothing extra when unfiltered',()=>{
    const plain=characterPath('series:s','all',revision,null);
    expect(plain).toContain('node=series%3As');
    expect(plain).not.toContain('media_kind');
    const filtered=characterPath('series:s','all',revision,'c1',{media:'videos',aspect:'all',duration:'all'});
    expect(filtered).toContain('cursor=c1');
    expect(filtered).toContain('media_kind=videos');
  });
});
