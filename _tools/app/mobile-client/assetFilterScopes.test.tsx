import type {ReactNode} from 'react';
import {cleanup, fireEvent, render, screen, waitFor} from '@testing-library/react';
import {afterEach, beforeEach, describe, expect, it, vi} from 'vitest';
const mocks=vi.hoisted(()=>({api:vi.fn(),native:vi.fn()}));
vi.mock('./transport',()=>({api:mocks.api,native:mocks.native,errorText:(reason:unknown)=>String(reason)}));
vi.mock('./media',()=>({mediaTicket:vi.fn(),loadThumbnail:()=>new Promise(()=>{})}));
// The virtualized Gallery has its own check; this file is about the scope's query contract.
vi.mock('./Gallery',()=>({Gallery:({intro,items,onNearEnd,identity}:{intro?:ReactNode;items:{id:string}[];onNearEnd():void;identity:string})=><div className="gallery-scroll" data-identity={identity}><ul>{intro}{items.map(item=><li key={item.id}>{item.id}</li>)}</ul><button data-testid="near-end" onClick={onNearEnd}>near end</button></div>}));
import {CharacterBrowser} from './CharacterBrowser';
import {characterPath} from './characterModel';
import type {CharacterIndex} from './characterModel';

const asset=(id:string,over:Record<string,unknown>={})=>({id,kind:'image',content_type:'image/png',size_bytes:10,thumbnail_available:true,...over});
const revision='a'.repeat(64);
const index:CharacterIndex={version:1,authority:'pc',authorityEpoch:0,capabilities:{read:true,write:false},ready:true,revision,publishedAt:null,nodes:[{id:'series:s',kind:'series',sourceId:'s',seriesId:'s',parentId:null,name:'Series',description:'',thumbnailAssetId:null,manualOnly:false,excluded:false}],scopes:[{nodeId:'series:s',filter:'all',totalCount:2,sourceCount:2}]};

beforeEach(()=>{vi.stubGlobal('ResizeObserver',class{observe(){}disconnect(){}});vi.stubGlobal('matchMedia',()=>({matches:false,addEventListener(){},removeEventListener(){}}));mocks.api.mockReset();mocks.native.mockReset();});
afterEach(()=>{cleanup();vi.unstubAllGlobals();});

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
    fireEvent.click(screen.getByRole('button',{name:'종류'}));
    expect(back.current?.()).toBe(true);
    await waitFor(()=>expect(screen.queryByRole('dialog',{name:'종류'})).toBeNull());
    expect(screen.getByText('a1')).toBeTruthy();
    fireEvent.click(screen.getByRole('button',{name:'종류'}));
    fireEvent.click([...screen.getByRole('radiogroup',{name:'종류'}).querySelectorAll('button')].find(b=>b.textContent==='영상')!);
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
    fireEvent.click(screen.getByRole('button',{name:'길이'}));
    const within=screen.getByRole('radiogroup',{name:'길이'});
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
    fireEvent.click(screen.getByRole('button',{name:'종류'}));
    const within=screen.getByRole('radiogroup',{name:'종류'});
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
    fireEvent.click(screen.getByRole('button',{name:'종류'}));
    fireEvent.click([...screen.getByRole('radiogroup',{name:'종류'}).querySelectorAll('button')].find(b=>b.textContent==='영상')!);
    await waitFor(()=>expect(failed).toBe(true));
    // The failed narrowing does not discard the page already on screen.
    await waitFor(()=>expect(screen.getAllByText(/character narrowing failed/).length).toBeGreaterThan(0));
    expect(screen.getByText('a1')).toBeTruthy();
    // The trigger reports the attempted set, so it is matched by prefix rather than exact name.
    // Choosing the same value again is already the attempt, so it is cleared and re-applied.
    fireEvent.click(screen.getByRole('button',{name:'종류'}));
    fireEvent.click([...screen.getByRole('radiogroup',{name:'종류'}).querySelectorAll('button')].find(b=>b.textContent==='전체')!);
    await waitFor(()=>expect(screen.queryByText(/character narrowing failed/)).toBeNull());
    expect(screen.getByRole('button',{name:'종류'})).toBeTruthy();
    fireEvent.click(screen.getByRole('button',{name:'종류'}));
    fireEvent.click([...screen.getByRole('radiogroup',{name:'종류'}).querySelectorAll('button')].find(b=>b.textContent==='영상')!);
    await waitFor(()=>expect(screen.getByText('f1')).toBeTruthy());
    expect(screen.getByRole('button',{name:'영상'})).toBeTruthy();
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
    fireEvent.click(screen.getByRole('button',{name:'종류'}));
    fireEvent.click([...screen.getByRole('radiogroup',{name:'종류'}).querySelectorAll('button')].find(b=>b.textContent==='영상')!);
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

it('clears character filters on Back before leaving a directly opened character scope',async()=>{
  mocks.api.mockImplementation(async(path:string)=>path==='/v1/library/characters'?index:{revision,filterVersion:1,items:[asset('a1')],totalCount:1,sourceCount:1,has_more:false,next_cursor:null});
  const back={current:null as (()=>boolean)|null};
  render(<CharacterBrowser initialNode="series:s" active paused={false} density={1} refreshKey={0} onOpen={()=>{}} backRef={back} onExit={()=>{}}/>);
  await screen.findByText('a1');fireEvent.click(screen.getByRole('button',{name:'종류'}));fireEvent.click(screen.getByRole('radio',{name:'영상'}));
  await screen.findByRole('button',{name:'영상'});
  expect(back.current?.()).toBe(true);await screen.findByRole('button',{name:'종류'});
  expect(back.current?.()).toBe(false);expect(screen.getByRole('heading',{name:'Series'})).toBeTruthy();
});
