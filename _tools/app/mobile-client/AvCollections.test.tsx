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
const openAv=async()=>fireEvent.click(await screen.findByRole('radio',{name:'AV'}));

beforeEach(()=>{
    localStorage.clear();for(const kind of ['game','movie','av'])localStorage.setItem(`lakomics.mobile.collectionView.${kind}.v1`,JSON.stringify({layout:'grid',perRow:4}));mocks.api.mockReset();mocks.native.mockReset();
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
  it('renders the 작품 list and the 배우별 shelves from the same fixture, and opens the performer page',async()=>{
    render(<Collections {...props}/>);
    await openAv();
    expect(await screen.findByText('오후의 창가')).toBeTruthy();
    expect(document.querySelector('.collection-grid')).toBeTruthy();
    fireEvent.click(screen.getByRole('tab',{name:'배우별'}));
    expect(document.querySelector('.av-performer-list')).toBeTruthy();
    const mio=await screen.findByRole('button',{name:/하야세 미오/});
    expect(screen.getByRole('group',{name:'하야세 미오 작품 선반'}).querySelectorAll('.collection-light-case')).toHaveLength(2);
    // The performer page: header band, 프로필 counts from the published works, the shelf, co-performers and labels.
    fireEvent.click(mio);
    const profile=await screen.findByRole('region',{name:'프로필 정보'});
    expect(screen.getByRole('heading',{level:1,name:'하야세 미오'})).toBeTruthy();
    expect(profile.textContent).toContain('2편 · 단독 1');
    expect(profile.textContent).toContain('8.14');
    expect(profile.textContent).toContain('4.0');
    expect(screen.getByRole('button',{name:'아마노 린 1편'})).toBeTruthy();
    expect(screen.getByRole('region',{name:'레이블'}).textContent).toContain('루미너스·프리미엄');
    fireEvent.click(screen.getByRole('radio',{name:'단독'}));
    await waitFor(()=>expect(screen.getByRole('group',{name:'배우 작품 선반'}).querySelectorAll('.collection-card')).toHaveLength(1));
    fireEvent.click(screen.getByRole('radio',{name:'전체'}));
    // A first tap turns the case to the front; a second opens the work, and Back returns to the performer.
    const work=()=>screen.getByRole('group',{name:'배우 작품 선반'}).querySelector('[data-collection-id="av-a"]') as HTMLElement;
    await waitFor(()=>expect(work()).toBeTruthy());
    fireEvent.click(work());expect(work().getAttribute('aria-selected')).toBe('true');
    fireEvent.click(work());
    expect(await screen.findByRole('article',{name:'AV 작품 화면'})).toBeTruthy();
    fireEvent.click(screen.getByRole('button',{name:'뒤로'}));
    expect(await screen.findByRole('region',{name:'프로필 정보'})).toBeTruthy();
    fireEvent.click(screen.getByRole('button',{name:'뒤로'}));
    expect(await screen.findByRole('tab',{name:'배우별'})).toBeTruthy();
  });

  it('stands AV works on the shelf as cases: a tap picks, a second tap opens the work screen with its flat jacket',async()=>{
    localStorage.setItem('lakomics.mobile.collectionView.av.v1',JSON.stringify({layout:'shelf',perRow:4}));
    const base=mocks.api.getMockImplementation()!;
    mocks.api.mockImplementation(async(path:string)=>path==='/v1/collections/av-b'?{revision:'r1',item:{...detail,...avB,type:'av',artworks:[]}}:base(path));
    render(<Collections {...props}/>);
    await openAv();
    const list=await screen.findByRole('group',{name:'AV 작품 목록'});
    const tile=list.querySelector('[data-collection-id="av-a"]') as HTMLElement;
    fireEvent.click(tile);
    expect(tile.getAttribute('aria-selected')).toBe('true');
    expect(screen.queryByRole('article',{name:'AV 작품 화면'})).toBeNull();
    fireEvent.click(tile);
    const screenArticle=await screen.findByRole('article',{name:'AV 작품 화면'});
    expect(screen.getByRole('heading',{level:1,name:'午後の窓辺と、ひとりの時間'})).toBeTruthy();
    // Front, spine and back come from the published artworks; the strip offers the flat jacket.
    await waitFor(()=>expect(screenArticle.querySelectorAll('.kase img.cv')).toHaveLength(3));
    expect(screen.getByRole('button',{name:'펼친 표지'})).toBeTruthy();
    expect(screen.getByText(/LMNS-123 · 8\.14 · 1 \/ 2/)).toBeTruthy();
    // The next work replaces this one once its faces are ready.
    fireEvent.click(screen.getByRole('button',{name:'다음 작품'}));
    await waitFor(()=>expect(screen.getByText(/LMNS-124 · 8\.14 · 2 \/ 2/)).toBeTruthy());
    expect((screen.getByRole('button',{name:'다음 작품'}) as HTMLButtonElement).disabled).toBe(true);
  });

  it('normalizes a typed code, sends the tablet client request, and records the sent code',async()=>{
    const base=mocks.api.getMockImplementation()!;
    mocks.api.mockImplementation(async(path:string,...args:unknown[])=>{
      if(path==='/v1/av-lookups')return {requestId:(args[1] as {requestId:string}).requestId,sequence:1,receivedAt:'2026-09-28T10:00:00Z'};
      return base(path);
    });
    render(<Collections {...props}/>);
    await openAv();
    const input=await screen.findByRole('textbox',{name:'품번'});
    fireEvent.change(input,{target:{value:'ssis123'}});
    expect(screen.getByText('SSIS-123',{selector:'strong'})).toBeTruthy();
    fireEvent.click(screen.getByRole('button',{name:'보내기'}));
    await waitFor(()=>expect(screen.getByText('SSIS-123을 PC로 보냈어요. PC에서 작품을 고르면 여기에 나타나요.')).toBeTruthy());
    const call=mocks.api.mock.calls.find(([path])=>path==='/v1/av-lookups');
    expect(call?.[2]).toMatchObject({productCode:'SSIS-123',sourceUrl:null});
    expect((call?.[2] as {requestId:string}).requestId).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i);
    expect(screen.getByRole('list',{name:'최근 보낸 품번'}).textContent).toContain('SSIS-123');
  });

  it('retries a failed send with the same request id',async()=>{
    const base=mocks.api.getMockImplementation()!;
    let failed=true;
    mocks.api.mockImplementation(async(path:string)=>{
      if(path==='/v1/av-lookups'){
        if(failed){failed=false;throw new Error('offline');}
        return {requestId:'retry',sequence:1,receivedAt:'2026-09-28T10:00:00Z'};
      }
      return base(path);
    });
    render(<Collections {...props}/>);
    await openAv();
    const input=await screen.findByRole('textbox',{name:'품번'});
    fireEvent.change(input,{target:{value:'SSIS-001'}});
    fireEvent.click(screen.getByRole('button',{name:'보내기'}));
    await screen.findByText(/오프라인이라 품번을 보내지 못했어요/);
    const retry=screen.getByRole('button',{name:'다시 보내기'});
    fireEvent.click(retry);
    await screen.findByText(/SSIS-001을 PC로 보냈어요/);
    const calls=mocks.api.mock.calls.filter(([path])=>path==='/v1/av-lookups');
    expect(calls).toHaveLength(2);
    expect((calls[0]![2] as {requestId:string}).requestId).toBe((calls[1]![2] as {requestId:string}).requestId);
  });

  it.each([
    [429,'요청이 많아요. 잠시 후 다시 보내 주세요'],
    [422,'품번이 올바르지 않아요. 예: SSIS-001'],
  ])('shows the server error for status %s',async(status,message)=>{
    const base=mocks.api.getMockImplementation()!;
    mocks.api.mockImplementation(async(path:string)=>{
      if(path==='/v1/av-lookups')throw {status};
      return base(path);
    });
    render(<Collections {...props}/>);
    await openAv();
    const input=await screen.findByRole('textbox',{name:'품번'});
    fireEvent.change(input,{target:{value:'SSIS-001'}});
    fireEvent.click(screen.getByRole('button',{name:'보내기'}));
    expect(await screen.findByText(message)).toBeTruthy();
  });

  it('keeps only the last five sent codes in local storage and on screen',async()=>{
    const base=mocks.api.getMockImplementation()!;
    mocks.api.mockImplementation(async(path:string)=>path==='/v1/av-lookups'?{}:base(path));
    render(<Collections {...props}/>);
    await openAv();
    const input=await screen.findByRole('textbox',{name:'품번'});
    for(let number=1;number<=6;number++){
      const code=`SSIS-${String(number).padStart(3,'0')}`;
      fireEvent.change(input,{target:{value:code}});
      fireEvent.click(screen.getByRole('button',{name:'보내기'}));
      await screen.findByText(new RegExp(`${code}을 PC로 보냈어요`));
    }
    const list=screen.getByRole('list',{name:'최근 보낸 품번'});
    expect(list.querySelectorAll('li')).toHaveLength(5);
    expect(list.textContent).not.toContain('SSIS-001');
    expect(JSON.parse(localStorage.getItem('lakomics.mobile.avLookupRecent')!)).toHaveLength(5);
  });

  it('persists the last-used 작품 · 배우별 view',async()=>{
    const first=render(<Collections {...props}/>);
    await openAv();
    await screen.findByText('오후의 창가');
    fireEvent.click(screen.getByRole('tab',{name:'배우별'}));
    expect(localStorage.getItem('lakomics.mobile.avListView')).toBe('performers');
    first.unmount();
    render(<Collections {...props}/>);
    await openAv();
    await waitFor(()=>expect(screen.getByRole('tab',{name:'배우별'})).toBeTruthy());
    expect(screen.getByRole('tab',{name:'배우별'}).getAttribute('aria-selected')).toBe('true');
  });

  it('shows the calm pre-publication empty state',async()=>{
    mocks.api.mockImplementation(async(path:string)=>path==='/v1/collections/status'?{revision:'r1'}:path.startsWith('/v1/collections?type=av')?page([]):{revision:1,counts:{unread:0,collections:[]},items:[],nextCursor:null,hasMore:false});
    render(<Collections {...props}/>);
    await openAv();
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
    await openAv();
    fireEvent.click(await screen.findByText('오후의 창가'));
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
    await waitFor(()=>expect(screen.queryByRole('radio',{name:'AV'})).toBeNull());
    expect(screen.getByRole('radio',{name:'게임'})).toBeTruthy();
  });
});
