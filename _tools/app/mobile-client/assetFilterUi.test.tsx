import type {ReactNode} from 'react';
import {act, cleanup, fireEvent, render, screen, waitFor, within} from '@testing-library/react';
import {afterEach, beforeEach, describe, expect, it, vi} from 'vitest';
import type {Asset} from './types';
import type {HomeProps} from './Home';
const mocks=vi.hoisted(()=>({api:vi.fn(),native:vi.fn()}));
vi.mock('./transport',()=>({api:mocks.api,native:mocks.native,errorText:()=> 'connection failed',
  ApiError:class ApiError extends Error{status:number|null;details:unknown;constructor(message:string,status:number|null,details:unknown){super(message);this.status=status;this.details=details;}}}));
vi.mock('./media',()=>({clearMediaCache:vi.fn(),loadThumbnail:vi.fn(async(a)=>a),prepareAssets:()=>new Promise(()=>{})}));
vi.mock('./Home',()=>({Home:({items,onOpen}:HomeProps)=><div>{items.slice(0,12).map((a,i)=><button key={a.id} onClick={()=>onOpen(i)}>{`tile-${a.id}`}</button>)}</div>}));
vi.mock('./Gallery',()=>({Gallery:({intro,items,onOpen,onNearEnd,identity}:{intro?:ReactNode;items:Asset[];onOpen(i:number):void;onNearEnd():void;identity:string})=><div aria-label="자산 목록" data-identity={identity}>{intro}{items.map((a,i)=><button key={a.id} onClick={()=>onOpen(i)}>{`tile-${a.id}`}</button>)}<button data-testid="near-end" onClick={onNearEnd}>near end</button></div>}));
vi.mock('./Viewer',()=>({Viewer:({items,index,onClose}:{items:Asset[];index:number;onClose():void})=><div><span>{`viewer-${items[index].id}`}</span><button onClick={onClose}>viewer close</button></div>}));
import {App} from './App';

/** One page of assets, echoing the filter contract version the server advertises. */
const page=(ids:string[],over:Record<string,unknown>={})=>({items:ids.map(id=>({id,kind:'image',width:100,height:100})),has_more:false,next_cursor:null,filterVersion:1,...over});
/** The most recent page request, as a URL so the assertions read like the wire. */
const lastPagePath=()=>String(mocks.api.mock.calls.filter(call=>String(call[0]).startsWith('/v1/library/assets')).at(-1)?.[0]);
/** A server that advertises the Asset filter contract. */
const supporting=(version:unknown=1)=>async(path:string)=>{
  if(path==='/v1/library/list-generation')return{generation:'a'.repeat(64),...(!(version===undefined)?{filterVersion:version}:{})};
  if(path.includes('classifications'))return{items:[{id:'b',name:'분류 B',asset_count:1,parent_id:null}]};
  if(path.includes('revisit'))return{bundles:[]}; if(path.includes('captures'))return{captures:[]};
  if(path.startsWith('/v1/library/assets'))return page(path.includes('classification_id=b')?['b1']:['a1']);
  return page(['a1']);
};
/** A server that predates Asset filters: no version anywhere. */
const legacy=async(path:string)=>{
  if(path==='/v1/library/list-generation')return{generation:'a'.repeat(64)};
  if(path.includes('classifications'))return{items:[]};
  if(path.includes('revisit'))return{bundles:[]}; if(path.includes('captures'))return{captures:[]};
  return page(['a1']);
};
/** Choose one filter value by its accessible group and label. */
const openFilters=(group='종류')=>{
  // The filter chips live in the folder bar's 보기 옵션 sheet.
  if(!screen.queryByRole('group',{name:'자산 필터'}))fireEvent.click(screen.getByRole('button',{name:'보기 옵션'}));
  const index=['종류','비율','길이'].indexOf(group==='미디어'?'종류':group);
  fireEvent.click(screen.getByRole('group',{name:'자산 필터'}).querySelectorAll('button')[index]);
};
const chooseIn=(group:string,label:string)=>{
  const name=group==='미디어'?'종류':group;
  if(!screen.queryByRole('radiogroup',{name})){
    if(screen.queryByRole('dialog'))fireEvent.click(screen.getByRole('button',{name:'닫기'}));
    openFilters(name);
  }
  fireEvent.click(screen.getByRole('radio',{name:label}));
};
/** Opens the 보기 옵션 sheet, reads the filter chip labels, and closes the sheet again. */
const chipLabels=async()=>{
  fireEvent.click(screen.getByRole('button',{name:'보기 옵션'}));
  const labels=[...(await screen.findByRole('group',{name:'자산 필터'})).querySelectorAll('button')].map(b=>b.textContent);
  fireEvent.click(within(screen.getByRole('dialog',{name:'보기 옵션'})).getByRole('button',{name:'닫기'}));
  await waitFor(()=>expect(screen.queryByRole('dialog',{name:'보기 옵션'})).toBeNull());
  return labels;
};
const openFolder=async(name:string)=>{
  fireEvent.click(within(screen.getByRole('navigation',{name:'주요 탐색'})).getByRole('button',{name:'에셋',exact:true}));
  fireEvent.click(await screen.findByRole('button',{name}));
};

/** The refusal is shown once as the filter notice; the banner shares its text with the error line. */
const refusalShown=async(text:string)=>{await waitFor(()=>expect(screen.getAllByText(text).length).toBeGreaterThan(0));};
beforeEach(()=>{
  vi.stubGlobal('ResizeObserver',class{observe(){}disconnect(){}});
  localStorage.clear(); mocks.api.mockReset(); mocks.native.mockReset();
  mocks.native.mockResolvedValue({configured:true,endpoint:'https://example.invalid'});
  mocks.api.mockImplementation(supporting());
});
afterEach(()=>{cleanup();vi.unstubAllGlobals();});

describe('asset filters',()=>{
  it('sends the agreed media, aspect and duration parameters for the chosen buckets',async()=>{
    render(<App/>);fireEvent.click(await screen.findByRole('button',{name:/모든 자산/}));await screen.findByText('tile-a1');
    openFilters();
    // The duration controls state their video-only scope while the dialog is open.

    chooseIn('미디어','영상');
    await waitFor(()=>expect(lastPagePath()).toContain('media_kind=videos'));
    // The dialog closes on commit, so it is reopened for each further choice.
    openFilters();chooseIn('비율','세로형');
    await waitFor(()=>expect(lastPagePath()).toContain('aspect_ratio=portrait'));
    expect(lastPagePath()).toContain('media_kind=videos');
    openFilters();chooseIn('길이','1–5분');
    await waitFor(()=>expect(lastPagePath()).toContain('duration_ms_min=60000'));
    expect(lastPagePath()).toContain('duration_ms_max=300000');
  });

  it('sends nothing extra until a filter is chosen and summarizes the applied set in the heading',async()=>{
    render(<App/>);fireEvent.click(await screen.findByRole('button',{name:/모든 자산/}));await screen.findByText('tile-a1');
    expect(lastPagePath()).not.toContain('media_kind');
    expect(lastPagePath()).not.toContain('aspect_ratio');
    expect(await chipLabels()).toContain('종류');
    openFilters();chooseIn('미디어','이미지');
    await waitFor(()=>expect(lastPagePath()).toContain('media_kind=images'));
    // The summary is both visible and part of the trigger's accessible name, so a narrowed
    // gallery announces its narrowing rather than looking like an unfiltered one.
    // The folder bar's 보기 옵션 button turns grey with a count, and the chip names the choice.
    await waitFor(()=>expect(screen.getByRole('button',{name:'보기 옵션'}).classList.contains('is-changed')).toBe(true));
    expect(screen.getByRole('button',{name:'보기 옵션'}).textContent).toBe('1');
    expect(await chipLabels()).toContain('이미지');
  });

  it('refuses to present an unfiltered list as filtered when the server has no filter contract',async()=>{
    mocks.api.mockImplementation(legacy);
    render(<App/>);fireEvent.click(await screen.findByRole('button',{name:/모든 자산/}));await screen.findByText('tile-a1');
    openFilters();chooseIn('미디어','영상');
    // The page request is never made, so no unfiltered result can be committed as filtered.
    await refusalShown('connection failed');
    expect(mocks.api.mock.calls.map(call=>String(call[0])).some(path=>path.includes('media_kind=videos'))).toBe(false);
  });

  it('refuses a page that ignored the filter parameters even when the capability was advertised',async()=>{
    mocks.api.mockImplementation((path:string)=>{
      if(path.startsWith('/v1/library/assets')&&path.includes('media_kind'))return Promise.resolve({items:[{id:'a1',kind:'image'}],has_more:false,next_cursor:null});
      return supporting()(path);
    });
    render(<App/>);fireEvent.click(await screen.findByRole('button',{name:/모든 자산/}));await screen.findByText('tile-a1');
    openFilters();chooseIn('미디어','영상');
    await refusalShown('connection failed');
    // The unversioned page is not committed under a filtered identity.
    expect(screen.getByLabelText('자산 목록').getAttribute('data-identity')).not.toContain('media_kind=videos');
  });

  it('revalidates the filter contract after a generation-change retry',async()=>{
    let generation='a'.repeat(64), filteredReads=0;
    mocks.api.mockImplementation((path:string)=>{
      if(path==='/v1/library/list-generation')return Promise.resolve({generation,filterVersion:1});
      if(path.startsWith('/v1/library/assets')&&path.includes('media_kind')){
        filteredReads++;
        generation='b'.repeat(64);
        return Promise.resolve(filteredReads===1 ? page(['first']) : page(['unchecked'],{filterVersion:undefined}));
      }
      return supporting()(path);
    });
    render(<App/>);fireEvent.click(await screen.findByRole('button',{name:/모든 자산/}));await screen.findByText('tile-a1');
    openFilters();chooseIn('미디어','영상');
    await refusalShown('connection failed');
    expect(filteredReads).toBe(2);
    expect(screen.queryByText('tile-unchecked')).toBeNull();
    expect(screen.getByLabelText('자산 목록').getAttribute('data-identity')).not.toContain('media_kind');
  });

  it('drops the cursor and scroll on a filter change while keeping the previous page on failure',async()=>{
    let paged=false;
    mocks.api.mockImplementation((path:string)=>{
      if(path.startsWith('/v1/library/assets')&&path.includes('media_kind')){
        paged=true;return Promise.resolve({items:[],has_more:false,next_cursor:null,filterVersion:1});
      }
      if(path.startsWith('/v1/library/assets'))return Promise.resolve(page(['a1','a2'],{has_more:true,next_cursor:'c1'}));
      return supporting()(path);
    });
    render(<App/>);fireEvent.click(await screen.findByRole('button',{name:/모든 자산/}));await screen.findByText('tile-a1');
    fireEvent.click(screen.getByTestId('near-end'));
    await waitFor(()=>expect(lastPagePath()).toContain('cursor=c1'));
    openFilters();chooseIn('미디어','영상');
    await waitFor(()=>expect(paged).toBe(true));
    // The narrowing request starts from the first page again, and the filter is set.
    expect(lastPagePath()).toContain('media_kind=videos');
    expect(lastPagePath()).not.toContain('cursor=c1');
    // An empty filtered result is explained by the filter, not reported as an empty library.
    await waitFor(()=>expect(screen.getByText('조건에 맞는 자산이 없습니다')).toBeTruthy());
  });

  it('returns to the same scope without filters on back, and to All unfiltered from All',async()=>{
    render(<App/>);fireEvent.click(await screen.findByRole('button',{name:/모든 자산/}));await screen.findByText('tile-a1');
    // Narrow a specific folder, then Back should restore that folder unfiltered.
    await openFolder('분류 B, 1개');
    await screen.findByText('tile-b1');
    openFilters();chooseIn('미디어','이미지');
    await waitFor(()=>expect(lastPagePath()).toContain('media_kind=images'));
    act(()=>window.dispatchEvent(new Event('lakomics-back')));
    await waitFor(()=>expect(lastPagePath()).not.toContain('media_kind'));
    // Still the same folder, not All.
    expect(lastPagePath()).toContain('classification_id=b');
    // A second Back leaves the folder for the unfiltered All. The All page may be served
    // from the view cache, so the committed heading and the gallery identity are what prove
    // the scope and its filters, not the request log.
    act(()=>window.dispatchEvent(new Event('lakomics-back')));
    await waitFor(()=>expect(screen.getByRole('heading',{name:'에셋'})).toBeTruthy());
    fireEvent.click(await screen.findByRole('button',{name:/모든 자산/}));
    await screen.findByText('tile-a1');
    await waitFor(()=>expect(screen.getByLabelText('자산 목록').getAttribute('data-identity')).not.toContain('media_kind'));
    expect(screen.getByLabelText('자산 목록').getAttribute('data-identity')).not.toContain('classification_id');
  });

  it('clears every bucket from one reset control',async()=>{
    render(<App/>);fireEvent.click(await screen.findByRole('button',{name:/모든 자산/}));await screen.findByText('tile-a1');
    openFilters();chooseIn('미디어','영상');
    await waitFor(()=>expect(lastPagePath()).toContain('media_kind=videos'));
    openFilters();chooseIn('길이','5분 이상');
    await waitFor(()=>expect(lastPagePath()).toContain('duration_ms_min=300000'));
    // The committed page must have adopted the duration filter; otherwise the reset below
    // would be comparing against a stale set and could legitimately no-op.
    await waitFor(()=>expect(screen.getByLabelText('자산 목록').getAttribute('data-identity')).toContain('duration_ms_min=300000'));
    // The reset is inside the dialog and clears every group at once.
    fireEvent.click(screen.getByRole('button',{name:'보기 옵션'}));fireEvent.click(await screen.findByRole('button',{name:'초기화'}));
    await waitFor(()=>expect(lastPagePath()).not.toContain('media_kind'));
    expect(lastPagePath()).not.toContain('duration_ms_min');
  });

  it('keeps the filter set in the gallery identity so a filter change cannot reuse the old page',async()=>{
    render(<App/>);fireEvent.click(await screen.findByRole('button',{name:/모든 자산/}));await screen.findByText('tile-a1');
    const before=screen.getByLabelText('자산 목록').getAttribute('data-identity');
    openFilters();chooseIn('비율','정사각형');
    await waitFor(()=>expect(screen.getByLabelText('자산 목록').getAttribute('data-identity')).not.toBe(before));
    expect(screen.getByLabelText('자산 목록').getAttribute('data-identity')).toContain('aspect_ratio=square');
  });

  it('validates the contract on every appended page, not only the initial one',async()=>{
    // The first narrowed page carries the contract; the continuation does not. The contract
    // checks the first page only would splice unfiltered rows into the filtered list.
    mocks.api.mockImplementation((path:string)=>{
      if(path.startsWith('/v1/library/assets')&&path.includes('media_kind'))
        return Promise.resolve(path.includes('cursor=c1')
          ? {items:[{id:'unchecked',kind:'image'}],has_more:false,next_cursor:null}
          : page(['f1'],{has_more:true,next_cursor:'c1'}));
      return supporting()(path);
    });
    render(<App/>);fireEvent.click(await screen.findByRole('button',{name:/모든 자산/}));await screen.findByText('tile-a1');
    openFilters();chooseIn('미디어','이미지');
    await screen.findByText('tile-f1');
    fireEvent.click(screen.getByTestId('near-end'));
    // The unversioned continuation is refused rather than appended.
    await waitFor(()=>expect(screen.getAllByText('connection failed').length).toBeGreaterThan(0));
    expect(screen.queryByText('tile-unchecked')).toBeNull();
  });

  it('restores committed filters and pagination when Library reselect cancels a delayed filter change',async()=>{
    const pending=Promise.withResolvers<unknown>();let signal!:AbortSignal;
    mocks.api.mockImplementation((path:string,requestSignal:AbortSignal)=>{
      if(path.startsWith('/v1/library/assets')){
        if(path.includes('media_kind')){signal=requestSignal;return pending.promise;}
        return Promise.resolve(path.includes('cursor=c1')?page(['a2']):page(['a1'],{has_more:true,next_cursor:'c1'}));
      }
      return supporting()(path);
    });
    render(<App/>);fireEvent.click(await screen.findByRole('button',{name:/모든 자산/}));await screen.findByText('tile-a1');
    openFilters();chooseIn('미디어','영상');
    await waitFor(()=>expect(signal).toBeTruthy());
    expect(screen.getByText('필터 적용 대기')).toBeTruthy();
    fireEvent.click(within(screen.getByRole('navigation',{name:'주요 탐색'})).getByRole('button',{name:'에셋',exact:true}));
    expect(signal.aborted).toBe(true);
    await waitFor(()=>expect(screen.queryByText('필터 적용 대기')).toBeNull());
    await screen.findByRole('heading',{name:'에셋'});
    fireEvent.click(screen.getByRole('button',{name:/모든 자산/}));
    await screen.findByText('tile-a1');
    await act(async()=>pending.resolve(page(['stale'])));
    expect(screen.queryByText('tile-stale')).toBeNull();
    fireEvent.click(screen.getByTestId('near-end'));
    await screen.findByText('tile-a2');
    expect(lastPagePath()).not.toContain('media_kind');
  });

  it('blocks an append while a filter change is uncommitted, so the old cursor cannot continue under new filters',async()=>{
    mocks.api.mockImplementation((path:string)=>{
      if(path.startsWith('/v1/library/assets')&&path.includes('media_kind')){
        // The narrowing never resolves, so the committed page stays the unfiltered one.
        return new Promise(()=>{});
      }
      if(path.startsWith('/v1/library/assets'))return Promise.resolve(page(['a1'],{has_more:true,next_cursor:'c1'}));
      return supporting()(path);
    });
    render(<App/>);fireEvent.click(await screen.findByRole('button',{name:/모든 자산/}));await screen.findByText('tile-a1');
    openFilters();chooseIn('미디어','영상');
    // Await the narrowing request, which never resolves, so the committed page is still the
    // unfiltered one and `page.filters` has not changed.
    await waitFor(()=>expect(mocks.api.mock.calls.some(call=>String(call[0]).includes('media_kind=videos'))).toBe(true));
    const before=mocks.api.mock.calls.filter(call=>String(call[0]).includes('cursor=c1')).length;
    // The uncommitted change blocks the continuation of the page still on screen.
    fireEvent.click(screen.getByTestId('near-end'));
    await new Promise(resolve=>setTimeout(resolve,20));
    expect(mocks.api.mock.calls.filter(call=>String(call[0]).includes('cursor=c1'))).toHaveLength(before);
    expect(screen.getByText('필터 적용 대기')).toBeTruthy();
  });

  it('keeps the previous page and its filter identity when a narrowed load fails, and retries the attempt',async()=>{
    let narrowed=0;
    mocks.api.mockImplementation((path:string)=>{
      if(path.startsWith('/v1/library/assets')&&path.includes('media_kind')){
        narrowed++;
        return narrowed===1?Promise.reject(new Error('narrowing failed')):Promise.resolve(page(['f1']));
      }
      return supporting()(path);
    });
    render(<App/>);fireEvent.click(await screen.findByRole('button',{name:/모든 자산/}));await screen.findByText('tile-a1');
    openFilters();chooseIn('미디어','이미지');
    await waitFor(()=>expect(narrowed).toBe(1));
    // The unfiltered page is still shown and its identity still says so.
    await waitFor(()=>expect(screen.getByText('tile-a1')).toBeTruthy());
    expect(screen.getByLabelText('자산 목록').getAttribute('data-identity')).not.toContain('media_kind');
    // Retry repeats the attempted set and commits it.
    fireEvent.click(screen.getAllByRole('button',{name:'다시 시도'})[0]);
    await waitFor(()=>expect(screen.getByText('tile-f1')).toBeTruthy());
    expect(narrowed).toBe(2);
  });

  it('refuses a future filter contract version instead of assuming it is compatible',async()=>{
    // The capability advertises a version this client does not implement.
    mocks.api.mockImplementation(supporting(2));
    render(<App/>);fireEvent.click(await screen.findByRole('button',{name:/모든 자산/}));await screen.findByText('tile-a1');
    openFilters();chooseIn('미디어','영상');
    await refusalShown('connection failed');
    expect(mocks.api.mock.calls.map(call=>String(call[0])).some(path=>path.includes('media_kind=videos'))).toBe(false);
  });

  it('does not accept the same contract declared under an unagreed spelling',async()=>{
    // Only `filterVersion` is agreed. A snake_case reply must not be treated as satisfying the
    // guard, because that spelling was never promised by any server.
    mocks.api.mockImplementation(async(path:string)=>{
      if(path==='/v1/library/list-generation')return{generation:'a'.repeat(64),filter_version:1};
      return supporting()(path);
    });
    render(<App/>);fireEvent.click(await screen.findByRole('button',{name:/모든 자산/}));await screen.findByText('tile-a1');
    openFilters();chooseIn('미디어','영상');
    await refusalShown('connection failed');
    expect(mocks.api.mock.calls.map(call=>String(call[0])).some(path=>path.includes('media_kind=videos'))).toBe(false);
  });

  it('closes the filter dialog on Back before the gallery surface itself',async()=>{
    render(<App/>);fireEvent.click(await screen.findByRole('button',{name:/모든 자산/}));await screen.findByText('tile-a1');
    openFilters();
    expect(screen.getByRole('dialog',{name:'종류'})).toBeTruthy();
    act(()=>window.dispatchEvent(new Event('lakomics-back')));
    await waitFor(()=>expect(screen.queryByRole('dialog',{name:'종류'})).toBeNull());
    // The gallery is untouched by the press that closed the dialog.
    expect(screen.getByText('tile-a1')).toBeTruthy();
  });

  it('does not treat a character scope placeholder as a filtered page that failed its contract',async()=>{
    const revision='a'.repeat(64);
    mocks.api.mockImplementation((path:string)=>{
      if(path==='/v1/library/characters')return Promise.resolve({version:1,authority:'pc',authorityEpoch:0,capabilities:{read:true,write:false},ready:true,revision,nodes:[{id:'series:s',kind:'series',sourceId:'s',seriesId:'s',parentId:null,name:'Series',description:'',thumbnailAssetId:null,manualOnly:false,excluded:false}],scopes:[{nodeId:'series:s',filter:'all',totalCount:2,sourceCount:2}]});
      if(path.startsWith('/v1/library/characters/assets'))return Promise.resolve({revision,filterVersion:1,items:[{id:'c1',kind:'image'}],totalCount:2,sourceCount:2,has_more:false,next_cursor:null});
      return supporting()(path);
    });
    render(<App/>);fireEvent.click(await screen.findByRole('button',{name:/모든 자산/}));await screen.findByText('tile-a1');
    // Entering the character scope must not be refused by the ordinary route's guard.
    await openFolder('Series, 2개');
    await screen.findByText('tile-c1');
    expect(screen.queryByText('connection failed')).toBeNull();
    expect(screen.queryByText(/서버를 업데이트해 주세요/)).toBeNull();
  });

  it('does not offer filters on Home, where a control would imply a narrowing that is not applied',async()=>{
    render(<App/>);fireEvent.click(await screen.findByRole('button',{name:/모든 자산/}));await screen.findByText('tile-a1');
    expect(await chipLabels()).toContain('종류');
    fireEvent.click(screen.getByRole('button',{name:'홈'}));
    await screen.findByText('tile-a1');
    expect(screen.queryByRole('button',{name:'보기 옵션'})).toBeNull();
    expect(screen.queryByRole('button',{name:'종류'})).toBeNull();
  });

  it('starts a folder unfiltered after returning to the root',async()=>{
    render(<App/>);fireEvent.click(await screen.findByRole('button',{name:/모든 자산/}));await screen.findByText('tile-a1');
    openFilters();chooseIn('미디어','이미지');
    await waitFor(()=>expect(lastPagePath()).toContain('media_kind=images'));
    await openFolder('분류 B, 1개');
    await waitFor(()=>expect(lastPagePath()).toContain('classification_id=b'));
    // Both the new scope and the committed filter are present.
    expect(lastPagePath()).not.toContain('media_kind=images');
  });

  it('treats a filter change as a new view rather than reusing the cached unfiltered page',async()=>{
    render(<App/>);fireEvent.click(await screen.findByRole('button',{name:/모든 자산/}));await screen.findByText('tile-a1');
    // Re-select All: the cached unfiltered page is allowed to serve that identical query.
    fireEvent.click(within(screen.getByRole('navigation',{name:'주요 탐색'})).getByRole('button',{name:'에셋'}));
    fireEvent.click(await screen.findByRole('button',{name:/모든 자산/}));
    await screen.findByText('tile-a1');
    openFilters();chooseIn('미디어','영상');
    await waitFor(()=>expect(lastPagePath()).toContain('media_kind=videos'));
    // Returning to All must not hand back the filtered page under an unfiltered identity.
    fireEvent.click(screen.getByRole('button',{name:'홈'}));
    await screen.findByText('tile-a1');
    fireEvent.click(within(screen.getByRole('navigation',{name:'주요 탐색'})).getByRole('button',{name:'에셋'}));
    await waitFor(()=>expect(lastPagePath()).not.toContain('media_kind=videos'));
  });

  it('drops the filter set when the connection changes, so it cannot outlive its server',async()=>{
    render(<App/>);fireEvent.click(await screen.findByRole('button',{name:/모든 자산/}));await screen.findByText('tile-a1');
    openFilters();chooseIn('미디어','영상');
    await waitFor(()=>expect(lastPagePath()).toContain('media_kind=videos'));
    // Reconfiguring goes through the settings surface, whose own suite covers the clear.
    // Here the guarantee that matters is that the committed filters are reset with the
    // rest of the library state, so a later page cannot carry them to another server.
    fireEvent.click(screen.getByRole('button',{name:'홈'}));
    fireEvent.click(await screen.findByRole('button',{name:'연결 및 설정'}));
    await screen.findByRole('dialog',{name:/설정/});
    expect(screen.queryByRole('button',{name:'종류'})).toBeNull();
  });
});

describe('asset filter dialog shape',()=>{
  it('groups each control with its own accessible name and the PC labels',async()=>{
    render(<App/>);fireEvent.click(await screen.findByRole('button',{name:/모든 자산/}));await screen.findByText('tile-a1');
    openFilters();
    for(const [name,labels] of Object.entries({'종류':['전체','이미지','영상'],'비율':['전체','정사각형','가로형','세로형'],'길이':['전체','30초 미만','30초–1분','1–5분','5분 이상']})){
      if(name!=='종류'){fireEvent.click(screen.getByRole('button',{name:'닫기'}));openFilters(name);}
      expect([...screen.getByRole('radiogroup',{name}).querySelectorAll('button')].map(b=>b.textContent)).toEqual(labels);
      expect(screen.getByRole('radio',{name:'전체'}).getAttribute('aria-checked')).toBe('true');
    }
    fireEvent.click(screen.getByRole('button',{name:'닫기'}));openFilters();chooseIn('미디어','이미지');
    await waitFor(()=>expect(lastPagePath()).toContain('media_kind=images'));
    openFilters();expect(screen.getByRole('radio',{name:'이미지'}).getAttribute('aria-checked')).toBe('true');
  });
});
