import {cleanup, fireEvent, render, screen, waitFor} from '@testing-library/react';
import {afterEach, beforeEach, describe, expect, it, vi} from 'vitest';
import type {CollectionDetail, CollectionPage, CollectionSummary} from './collectionModel';

const mocks=vi.hoisted(()=>({api:vi.fn(),native:vi.fn()}));
vi.mock('./transport',()=>({api:mocks.api,native:mocks.native,errorText:(reason:unknown)=>String(reason)}));
vi.mock('./media',()=>({mediaTicket:vi.fn()}));
import {Collections} from './Collections';

const coverArtwork={id:'cover-a',kind:'cover',selected:true,thumbnailAvailable:true,originalAvailable:true};
const spineArtwork={id:'spine-a',kind:'spine',selected:false,thumbnailAvailable:true,originalAvailable:true};
const backArtwork={id:'back-a',kind:'back',selected:false,thumbnailAvailable:true,originalAvailable:true};
const avPeople=[
  {id:'p1',name:'하야세 미오',nameJa:'早瀬みお',role:'performer' as const,order:0,portraitCrop:{artworkId:'cover-a',x:0,y:0,w:.5,h:.75}},
  {id:'p2',name:'아마노 린',nameJa:'天野りん',role:'performer' as const,order:1,portraitCrop:null},
];
const avA:CollectionSummary={id:'av-a',name:'오후의 창가',type:'av',selectedWorkArtworkId:'cover-a',artworkVersions:{'cover-a':{thumbnail:'thumb-a',original:'original-a'}},releaseDate:'2026-08-14',myScore:4,av:{productCode:'LMNS-123',titleJa:'午後の窓辺と、ひとりの時間',maker:'루미너스映像',label:'루미너스·프리미엄',series:'窓辺の午後',genres:['드라마','4K'],releaseDate:'2026-08-14',people:avPeople},showcase:true,createdAt:'2026-08-14T00:00:00Z'};
const avB:CollectionSummary={...avA,id:'av-b',name:'다른 오후',selectedWorkArtworkId:'cover-b',artworkVersions:{'cover-b':{thumbnail:'thumb-b'}},av:{...avA.av,productCode:'LMNS-124',people:[avPeople[0]!]}};
const detail:CollectionDetail={...avA,type:'av',volumes:[],artworks:[coverArtwork,spineArtwork,backArtwork],artworkVersions:{'cover-a':{thumbnail:'thumb-a',original:'original-a'},'spine-a':{thumbnail:'spine-thumb',original:'spine-original'},'back-a':{thumbnail:'back-thumb',original:'back-original'}}};
const page=(items:CollectionSummary[]):CollectionPage=>({ready:true,filterVersion:1,revision:'r1',publishedAt:null,totalCount:items.length,items,nextCursor:null});
const props={active:true,paused:false,backRef:{current:null}};

beforeEach(()=>{
    localStorage.clear();mocks.api.mockReset();mocks.native.mockReset();
  mocks.native.mockImplementation(async(_operation,payload)=>({url:`https://example.invalid/${payload.artworkId??'asset'}-${payload.variant}`}));
  mocks.api.mockImplementation(async(path:string)=>{
    if(path==='/v1/collections/status')return {revision:'r1'};
    if(path==='/v1/collections/releases')return {revision:1,counts:{unread:0,collections:[]},items:[],nextCursor:null,hasMore:false};
    if(path==='/v1/collections/av-a')return {revision:'r1',item:detail};
    if(path.startsWith('/v1/collections?type=av'))return page([avA,avB]);
    return page([]);
  });
});
afterEach(()=>{cleanup();vi.restoreAllMocks();});

describe('tablet AV collections',()=>{
  it('renders the 작품 grid and the 배우별 shelves from the same fixture',async()=>{
    render(<Collections {...props}/>);
    fireEvent.click(await screen.findByRole('tab',{name:'AV'}));
    expect(await screen.findByText('LMNS-123')).toBeTruthy();
    expect(document.querySelector('.av-grid')).toBeTruthy();
    fireEvent.click(screen.getByRole('button',{name:'배우'}));
    fireEvent.click(screen.getByRole('radio',{name:/아마노 린/}));
    expect(document.querySelectorAll('.av-grid .av-work-card')).toHaveLength(1);
    fireEvent.click(screen.getByRole('tab',{name:'배우별'}));
    expect(await screen.findByText('하야세 미오')).toBeTruthy();
    expect(document.querySelector('.av-performer-list')).toBeTruthy();
  });

  it('persists the last-used 작품 · 배우별 view',async()=>{
    const first=render(<Collections {...props}/>);
    fireEvent.click(await screen.findByRole('tab',{name:'AV'}));
    await screen.findByText('LMNS-123');
    fireEvent.click(screen.getByRole('tab',{name:'배우별'}));
    expect(localStorage.getItem('lakomics.mobile.avListView')).toBe('performers');
    first.unmount();
    render(<Collections {...props}/>);
    fireEvent.click(await screen.findByRole('tab',{name:'AV'}));
    await waitFor(()=>expect(screen.getByRole('tab',{name:'배우별'})).toBeTruthy());
    expect(screen.getByRole('tab',{name:'배우별'}).getAttribute('aria-selected')).toBe('true');
  });

  it('shows the calm pre-publication empty state',async()=>{
    mocks.api.mockImplementation(async(path:string)=>path==='/v1/collections/status'?{revision:'r1'}:path.startsWith('/v1/collections?type=av')?page([]):{revision:1,counts:{unread:0,collections:[]},items:[],nextCursor:null,hasMore:false});
    render(<Collections {...props}/>);
    fireEvent.click(await screen.findByRole('tab',{name:'AV'}));
    expect(await screen.findByText('PC 앱이 AV 작품을 아직 보내지 않았습니다')).toBeTruthy();
  });

  it('hides empty computed shelves and uses a crop portrait beside initials',async()=>{
    const one=page([avA]);
    mocks.api.mockImplementation(async(path:string)=>{
      if(path==='/v1/collections/status')return {revision:'r1'};
      if(path==='/v1/collections/av-a')return {revision:'r1',item:detail};
      if(path.startsWith('/v1/collections?type=av'))return one;
      return {revision:1,counts:{unread:0,collections:[]},items:[],nextCursor:null,hasMore:false};
    });
    render(<Collections {...props}/>);
    fireEvent.click(await screen.findByRole('tab',{name:'AV'}));
    fireEvent.click(await screen.findByText('LMNS-123'));
    expect(await screen.findByRole('heading',{name:'午後の窓辺と、ひとりの時間'})).toBeTruthy();
    expect(screen.queryByLabelText('같은 배우의 다른 작품')).toBeNull();
    expect(screen.queryByLabelText('같은 시리즈')).toBeNull();
    expect(screen.queryByLabelText('같은 레이블')).toBeNull();
    const cropped=await screen.findByLabelText('하야세 미오 사진');
    expect(cropped.className).toContain('has-image');
    expect(cropped.getAttribute('style')).toContain('background-image');
    const initials=screen.getByLabelText('아마노 린 사진');
    expect(initials.className).not.toContain('has-image');
    expect(initials.textContent).toContain('아');
  });

  it('removes AV from the type tabs while privacy mode is enabled',async()=>{
    localStorage.setItem('lakomics.mobile.privacyMode','1');
    render(<Collections {...props}/>);
    await waitFor(()=>expect(screen.queryByRole('tab',{name:'AV'})).toBeNull());
    expect(screen.getByRole('tab',{name:'게임'})).toBeTruthy();
  });
});
