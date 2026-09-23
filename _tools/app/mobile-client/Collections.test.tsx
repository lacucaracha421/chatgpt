import {act, cleanup, fireEvent, render, screen, waitFor, within} from '@testing-library/react';
import {afterEach, beforeEach, describe, expect, it, vi} from 'vitest';
import {collectionCardCredit, collectionCardDate, collectionPath, editionVolumes, editions} from './collectionModel';
import type {CollectionDetail, CollectionPage} from './collectionModel';
const mocks=vi.hoisted(()=>({api:vi.fn(),native:vi.fn()}));
vi.mock('./transport',()=>({api:mocks.api,native:mocks.native,errorText:(reason:unknown)=>String(reason)}));
vi.mock('./media',()=>({mediaTicket:vi.fn()}));
import {Collections} from './Collections';
const item:CollectionDetail={id:'manga-1',name:'밤의 도서관',type:'game',showcase:true,selectedWorkArtworkId:'cover',volumes:[{id:'v2',volumeNumber:2,editionIndex:0,displayLabel:'2권',coverArtworkId:'c2'},{id:'e1',volumeNumber:1,editionIndex:1,displayLabel:'특별판 1권',coverArtworkId:'e1'},{id:'v1',volumeNumber:1,editionIndex:0,displayLabel:'1',coverArtworkId:'c1'}],artworks:[]};
const page:CollectionPage={ready:true,filterVersion:1,revision:'r1',publishedAt:null,items:[item],nextCursor:null};
const section=()=>screen.getByLabelText('컬렉션',{selector:'section'});
const list=()=>section().querySelector('.collection-list') as HTMLElement;
const detailPane=()=>section().querySelector('.collection-detail') as HTMLElement;
const pressTab=(name:string)=>fireEvent.click(screen.getByRole('tab',{name}));
const searchBox=()=>screen.getByRole('searchbox',{name:'컬렉션 검색'}) as HTMLInputElement;
/** A downward pull from the top of a scroller is the refresh gesture. */
function pull(element:HTMLElement){fireEvent.touchStart(element,{touches:[{clientX:0,clientY:0}]});fireEvent.touchMove(element,{touches:[{clientX:0,clientY:200}]});fireEvent.touchEnd(element);}
/** jsdom has no layout, so the scroller's geometry is declared before the scroll event. */
function scrollToEnd(element:HTMLElement){Object.defineProperty(element,'clientHeight',{configurable:true,value:500});Object.defineProperty(element,'scrollHeight',{configurable:true,value:600});element.scrollTop=100;fireEvent.scroll(element);}
const metadataBlock=()=>screen.getByLabelText('작품 정보',{selector:'dl'});
beforeEach(()=>{mocks.api.mockReset();mocks.native.mockReset();mocks.api.mockImplementation(async(path:string)=>path.includes('/v1/collections/')?{revision:'r1',item}:page);mocks.native.mockResolvedValue({url:'https://example.invalid/cover',expires_in:300});});
afterEach(()=>{cleanup();vi.restoreAllMocks();vi.unstubAllGlobals();});
describe('tab return retention',()=>{
  const listCalls=()=>mocks.api.mock.calls.filter(([path])=>path.startsWith('/v1/collections?')&&!path.includes('showcase=true'));
  const detailCalls=()=>mocks.api.mock.calls.filter(([path])=>path===`/v1/collections/${item.id}`);
  const artworkCalls=(id:string,variant='thumbnail')=>mocks.native.mock.calls.filter(([op,payload])=>op==='collectionArtwork'&&payload.artworkId===id&&payload.variant===variant);

  it.each(['inactive','paused'] as const)('retains a committed page, scroll and artwork after %s return',async(mode)=>{
    const props={active:true,paused:false,backRef:{current:null}};
    const view=render(<Collections {...props}/>);await screen.findByText(item.name);
    list().scrollTop=140;fireEvent.scroll(list());
    const image=await screen.findByRole('img',{name:item.name});fireEvent.load(image);
    expect(artworkCalls('cover')).toHaveLength(1);
    view.rerender(<Collections {...props} active={mode!=='inactive'} paused={mode==='paused'}/>);
    view.rerender(<Collections {...props}/>);
    expect(screen.queryByText('컬렉션을 불러오는 중…')).toBeNull();
    await act(async()=>{});
    expect(listCalls()).toHaveLength(1);expect(list().scrollTop).toBe(140);
    expect(screen.getByRole('img',{name:item.name})).toBe(image);
    expect(artworkCalls('cover')).toHaveLength(1);
  });

  it.each(['inactive','paused'] as const)('retains detail edition, expanded volumes and hero after %s return',async(mode)=>{
    const work:CollectionDetail={...item,selectedHeroArtworkId:'hero',artworks:[{id:'hero',kind:'hero',selected:true,thumbnailAvailable:true,originalAvailable:true}],volumes:[...item.volumes,...Array.from({length:100},(_,i)=>({id:`extra-${i}`,volumeNumber:i+2,editionIndex:1,displayLabel:`특별판 ${i+2}권`}))]};
    mocks.api.mockImplementation(async(path:string)=>path.endsWith('/status')?{revision:'r1'}:path.startsWith('/v1/collections?')?page:{revision:'r1',item:work});
    const decode=vi.fn().mockResolvedValue(undefined);
    vi.stubGlobal('Image',class {src='';decode=decode;});
    const props={active:true,paused:false,backRef:{current:null}};
    const view=render(<Collections {...props}/>);fireEvent.click(await screen.findByText(item.name));
    fireEvent.click(await screen.findByRole('radio',{name:'판본 2'}));
    fireEvent.click(screen.getByRole('button',{name:'표지 더 보기'}));
    await waitFor(()=>expect(document.querySelector('.collection-hero-original')).not.toBeNull());
    const hero=document.querySelector('.collection-hero-original');
    view.rerender(<Collections {...props} active={mode!=='inactive'} paused={mode==='paused'}/>);
    view.rerender(<Collections {...props}/>);await act(async()=>{});
    expect(listCalls()).toHaveLength(1);expect(detailCalls()).toHaveLength(1);
    expect(screen.getByRole('radio',{name:'판본 2'}).getAttribute('aria-checked')).toBe('true');
    expect(within(screen.getByRole('region',{name:'권별 표지'})).getAllByRole('button').filter(button=>button.classList.contains('collection-tile'))).toHaveLength(101);
    expect(document.querySelector('.collection-hero-original')).toBe(hero);
    expect(artworkCalls('hero','original')).toHaveLength(1);expect(decode).toHaveBeenCalledTimes(1);
  });

  it('appends the next page on scroll, retains it on return and restarts after a query change',async()=>{
    mocks.api.mockImplementation(async(path:string)=>path.endsWith('/status')?{revision:'r1'}:path.includes('cursor=')?{...page,nextCursor:null,items:[{...item,id:'second',name:'Second page'}]}:{...page,nextCursor:'page-2'});
    const props={active:true,paused:false,backRef:{current:null}};const view=render(<Collections {...props}/>);
    await screen.findByText(item.name);scrollToEnd(list());
    await screen.findByText('Second page');
    // Continuous scrolling keeps the first page instead of replacing it.
    expect(screen.getByText(item.name)).toBeTruthy();
    view.rerender(<Collections {...props} active={false}/>);view.rerender(<Collections {...props}/>);await act(async()=>{});
    expect(listCalls()).toHaveLength(2);expect(screen.getByText('Second page')).toBeTruthy();
    pressTab('만화');await waitFor(()=>expect(listCalls()).toHaveLength(3));
    expect(listCalls().at(-1)?.[0]).toContain('type=manga');
    expect(listCalls().at(-1)?.[0]).not.toContain('cursor=');
    await waitFor(()=>expect(screen.queryByText('Second page')).toBeNull());
  });

  it('restarts the list when a later page belongs to a newer publication',async()=>{
    let revision='r1';
    mocks.api.mockImplementation(async(path:string)=>path.endsWith('/status')?{revision:'r1'}:path.includes('cursor=')?{...page,revision:'r2',items:[{...item,id:'x',name:'mixed'}]}:{...page,revision,nextCursor:'page-2'});
    render(<Collections active paused={false} backRef={{current:null}}/>);await screen.findByText(item.name);
    revision='r2';scrollToEnd(list());
    await waitFor(()=>expect(listCalls()).toHaveLength(3));
    expect(listCalls().at(-1)?.[0]).not.toContain('cursor=');expect(screen.queryByText('mixed')).toBeNull();
  });

  it('does not start requests while initially paused and resumes interrupted list/detail loads',async()=>{
    const props={active:true,paused:false,backRef:{current:null}};
    const oldList=Promise.withResolvers<CollectionPage>(),oldDetail=Promise.withResolvers<{revision:string;item:CollectionDetail}>();
    let lists=0,details=0;
    mocks.api.mockImplementation((path:string)=>{
      if(path.endsWith('/status'))return Promise.resolve({revision:'r1'});
      if(path.startsWith('/v1/collections?'))return ++lists===1?oldList.promise:Promise.resolve(page);
      return ++details===1?oldDetail.promise:Promise.resolve({revision:'r1',item});
    });
    const view=render(<Collections {...props} paused/>);await act(async()=>{});
    expect(mocks.api).not.toHaveBeenCalled();
    view.rerender(<Collections {...props}/>);expect(lists).toBe(1);
    const listSignal=listCalls()[0][1] as AbortSignal;
    view.rerender(<Collections {...props} paused/>);expect(listSignal.aborted).toBe(true);
    view.rerender(<Collections {...props}/>);fireEvent.click(await screen.findByText(item.name));
    expect(details).toBe(1);const detailSignal=detailCalls()[0][1] as AbortSignal;
    view.rerender(<Collections {...props} active={false}/>);expect(detailSignal.aborted).toBe(true);
    view.rerender(<Collections {...props}/>);await screen.findByRole('heading',{level:1,name:item.name});
    await act(async()=>{oldList.resolve({...page,items:[{...item,name:'stale list'}]});oldDetail.resolve({revision:'old',item:{...item,name:'stale detail'}});});
    expect(lists).toBe(2);expect(details).toBe(2);
    expect(screen.queryByText('stale list')).toBeNull();expect(screen.queryByText('stale detail')).toBeNull();
  });

  it('retries failed list and detail loads on return without hiding committed detail on refresh failure',async()=>{
    const props={active:true,paused:false,backRef:{current:null}};
    let failList=true,failDetail=true;
    mocks.api.mockImplementation(async(path:string)=>{
      if(path.endsWith('/status'))return {revision:'r1'};
      if(path.startsWith('/v1/collections?')){if(failList)throw new Error('list offline');return page;}
      if(failDetail)throw new Error('detail offline');return {revision:'r1',item};
    });
    const view=render(<Collections {...props}/>);await screen.findByText(/list offline/);failList=false;
    view.rerender(<Collections {...props} active={false}/>);view.rerender(<Collections {...props}/>);
    fireEvent.click(await screen.findByText(item.name));await screen.findByText(/detail offline/);failDetail=false;
    view.rerender(<Collections {...props} paused/>);view.rerender(<Collections {...props}/>);
    await screen.findByRole('heading',{level:1,name:item.name});
    failDetail=true;pull(detailPane());await screen.findByText(/detail offline/);
    expect(screen.getByRole('heading',{level:1,name:item.name})).toBeTruthy();
    failDetail=false;view.rerender(<Collections {...props} active={false}/>);view.rerender(<Collections {...props}/>);
    await waitFor(()=>expect(screen.queryByText(/detail offline/)).toBeNull());
    expect(listCalls()).toHaveLength(2);expect(detailCalls()).toHaveLength(4);
  });

  it('refreshes by pulling and on publication change while retaining the old page until replacement commits',async()=>{
    let revision='r1';const replacement=Promise.withResolvers<CollectionPage>();let lists=0;
    mocks.api.mockImplementation((path:string)=>{
      if(path.endsWith('/status'))return Promise.resolve({revision});
      if(path.startsWith('/v1/collections?'))return ++lists===2?replacement.promise:Promise.resolve({...page,revision});
      return Promise.resolve({revision,item});
    });
    const props={active:true,paused:false,backRef:{current:null}};
    const view=render(<Collections {...props}/>);await screen.findByText(item.name);
    pull(list());expect(listCalls()).toHaveLength(2);
    expect(screen.getByText(item.name)).toBeTruthy();
    await act(async()=>replacement.resolve(page));
    fireEvent.click(screen.getByText(item.name));await screen.findByRole('heading',{level:1,name:item.name});
    revision='r2';view.rerender(<Collections {...props} active={false}/>);view.rerender(<Collections {...props}/>);
    await waitFor(()=>expect(detailCalls()).toHaveLength(2));
    expect(listCalls()).toHaveLength(3);
    await act(async()=>{});view.rerender(<Collections {...props} paused/>);view.rerender(<Collections {...props}/>);
    await act(async()=>{});expect(listCalls()).toHaveLength(3);expect(detailCalls()).toHaveLength(2);
  });

  it('retries failed artwork on return, and reloads changed digest/revision without reusing the old source',async()=>{
    let work={...item,artworkVersions:{cover:{thumbnail:'digest-1'}}},revision='r1';
    mocks.api.mockImplementation(async(path:string)=>path.endsWith('/status')?{revision}:{...page,revision,items:[work]});
    mocks.native.mockRejectedValueOnce(new Error('media offline')).mockImplementation(async(_op,payload)=>({url:`https://example.invalid/${payload.revision}-${payload.digest}`}));
    const props={active:true,paused:false,backRef:{current:null}};const view=render(<Collections {...props}/>);
    await screen.findByText('이미지를 불러오지 못했습니다');
    view.rerender(<Collections {...props} active={false}/>);view.rerender(<Collections {...props}/>);
    const image=await screen.findByRole('img',{name:item.name});expect(artworkCalls('cover')).toHaveLength(2);
    fireEvent.error(image);view.rerender(<Collections {...props} paused/>);view.rerender(<Collections {...props}/>);
    await screen.findByRole('img',{name:item.name});expect(artworkCalls('cover')).toHaveLength(3);
    work={...work,artworkVersions:{cover:{thumbnail:'digest-2'}}};pull(list());
    await waitFor(()=>expect(screen.getByRole('img',{name:item.name}).getAttribute('src')).toContain('digest-2'));
    expect(artworkCalls('cover')).toHaveLength(4);
    revision='r2';pull(list());
    await waitFor(()=>expect(screen.getByRole('img',{name:item.name}).getAttribute('src')).toContain('r2-digest-2'));
    expect(artworkCalls('cover')).toHaveLength(5);
  });

  it('retries interrupted artwork and ignores a late ticket from the abandoned request',async()=>{
    const old=Promise.withResolvers<{url:string}>();
    mocks.native.mockReturnValueOnce(old.promise).mockResolvedValue({url:'https://example.invalid/current'});
    const props={active:true,paused:false,backRef:{current:null}};const view=render(<Collections {...props}/>);
    await screen.findByText(item.name);await waitFor(()=>expect(artworkCalls('cover')).toHaveLength(1));
    const signal=artworkCalls('cover')[0][2] as AbortSignal;
    view.rerender(<Collections {...props} active={false}/>);expect(signal.aborted).toBe(true);
    view.rerender(<Collections {...props}/>);
    await screen.findByRole('img',{name:item.name});expect(artworkCalls('cover')).toHaveLength(2);
    await act(async()=>old.resolve({url:'https://example.invalid/stale'}));
    expect(screen.getByRole('img',{name:item.name}).getAttribute('src')).toBe('https://example.invalid/current');
    view.rerender(<Collections {...props} paused/>);view.rerender(<Collections {...props}/>);await act(async()=>{});
    expect(artworkCalls('cover')).toHaveLength(2);
  });

  it('retries hero decode failures and reloads an original when its digest or availability changes',async()=>{
    let work:CollectionDetail={...item,selectedHeroArtworkId:'hero',artworkVersions:{hero:{original:'one'}},artworks:[{id:'hero',kind:'hero',selected:true,thumbnailAvailable:true,originalAvailable:true}]};
    mocks.api.mockImplementation(async(path:string)=>path.endsWith('/status')?{revision:'r1'}:path.startsWith('/v1/collections?')?page:{revision:'r1',item:work});
    mocks.native.mockImplementation(async(_op,payload)=>({url:`https://example.invalid/${payload.artworkId}-${payload.variant}-${payload.digest}`}));
    const decode=vi.fn().mockRejectedValueOnce(new Error('decode failed')).mockResolvedValue(undefined);
    vi.stubGlobal('Image',class {src='';decode=decode;});
    const props={active:true,paused:false,backRef:{current:null}};const view=render(<Collections {...props}/>);
    fireEvent.click(await screen.findByText(item.name));await waitFor(()=>expect(decode).toHaveBeenCalledTimes(1));
    await act(async()=>{});expect(document.querySelector('.collection-hero-original')).toBeNull();
    view.rerender(<Collections {...props} paused/>);view.rerender(<Collections {...props}/>);
    await waitFor(()=>expect(document.querySelector('.collection-hero-original')).not.toBeNull());
    expect(artworkCalls('hero','original')).toHaveLength(2);
    work={...work,artworkVersions:{hero:{original:'two'}}};pull(detailPane());
    await waitFor(()=>expect(document.querySelector('.collection-hero-original')?.getAttribute('src')).toContain('-two'));
    work={...work,artworks:work.artworks.map(art=>({...art,originalAvailable:false}))};pull(detailPane());
    await waitFor(()=>expect(document.querySelector('.collection-hero-original')).toBeNull());
  });
});

describe('read-only collections',()=>{
  it('sorts and filters the server list from chips, restarts the scroll and keeps per-type choices',async()=>{
    mocks.api.mockResolvedValue({...page,nextCursor:'page-2'});
    render(<Collections active paused={false} backRef={{current:null}}/>);await screen.findByText('밤의 도서관');
    scrollToEnd(list());
    await waitFor(()=>expect(mocks.api.mock.calls.at(-1)?.[0]).toContain('cursor=page-2'));
    fireEvent.click(screen.getByRole('button',{name:/내 별점/}));
    fireEvent.click(within(screen.getByRole('dialog')).getByRole('radio',{name:'4.5점'}));
    await waitFor(()=>expect(mocks.api.mock.calls.at(-1)?.[0]).toContain('rating=4.5'));
    expect(mocks.api.mock.calls.at(-1)?.[0]).not.toContain('cursor=');
    expect(screen.queryByRole('dialog')).toBeNull();
    fireEvent.click(screen.getByRole('button',{name:/출시·출간·개봉일 · 최신순/}));
    fireEvent.click(within(screen.getByRole('dialog')).getByRole('radio',{name:'최근 추가'}));
    await waitFor(()=>expect(mocks.api.mock.calls.at(-1)?.[0]).toContain('sort=recent'));
    fireEvent.click(within(screen.getByRole('dialog')).getByRole('radio',{name:'오래된순'}));
    await waitFor(()=>expect(mocks.api.mock.calls.at(-1)?.[0]).toContain('direction=asc'));
    fireEvent.click(within(screen.getByRole('dialog')).getByRole('button',{name:'닫기'}));
    expect(screen.getByRole('button',{name:/최근 추가 · 오래된순/})).toBeTruthy();
    expect(screen.getByRole('button',{name:/★ 4\.5/})).toBeTruthy();
    pressTab('만화');
    await waitFor(()=>expect(screen.getByRole('button',{name:/^내 별점/})).toBeTruthy());
    pressTab('게임');
    await waitFor(()=>expect(screen.getByRole('button',{name:/★ 4\.5/})).toBeTruthy());
    fireEvent.click(screen.getByRole('button',{name:'초기화'}));
    await waitFor(()=>expect(mocks.api.mock.calls.at(-1)?.[0]).toContain('rating=all'));
  });
  it('keeps Showcase folded until asked, then reads it without list filters and opens its full view',async()=>{
    const backRef:{current:(()=>boolean)|null}={current:null};
    render(<Collections active paused={false} backRef={backRef}/>);await screen.findByText('밤의 도서관');
    const showcaseCalls=()=>mocks.api.mock.calls.filter(([path])=>path.includes('showcase=true'));
    const fold=screen.getByRole('button',{name:/쇼케이스/});
    expect(fold.getAttribute('aria-expanded')).toBe('false');expect(showcaseCalls()).toHaveLength(0);
    fireEvent.click(fold);
    await waitFor(()=>expect(showcaseCalls()).toHaveLength(1));
    expect(showcaseCalls()[0][0]).not.toMatch(/rating=|sort=/);
    fireEvent.click(screen.getByRole('button',{name:'전체 보기'}));
    expect(await screen.findByText('PC에서 정한 순서대로 보여 줍니다.')).toBeTruthy();
    act(()=>{expect(backRef.current?.()).toBe(true);});
    expect(screen.getByRole('tab',{name:'게임'})).toBeTruthy();
    expect(showcaseCalls()).toHaveLength(1);
  });
  it('does not present unfiltered results from an older server as filtered results',async()=>{
    mocks.api.mockResolvedValue({...page,filterVersion:undefined});
    render(<Collections active paused={false} backRef={{current:null}}/>);
    await screen.findByText('별점 필터와 정렬을 사용하려면 서버 업데이트가 필요합니다.',{exact:false});
    expect(screen.queryByText('밤의 도서관')).toBeNull();
  });
  it('keeps identity and edition order and encodes bounded queries',()=>{
    expect(editions(item.volumes)).toEqual([0,1]);expect(editionVolumes(item.volumes,0).map(v=>v.id)).toEqual(['v1','v2']);expect(item.volumes[0].id).toBe('v2');
    const path=new URL(collectionPath('manga','a & b',true,'opaque/+'),'https://example.invalid');expect(path.searchParams.get('q')).toBe('a & b');expect(path.searchParams.get('cursor')).toBe('opaque/+');expect(path.searchParams.get('limit')).toBe('16');
  });
  it('distinguishes unpublished, published empty, and older server',async()=>{
    mocks.api.mockResolvedValueOnce({...page,ready:false,items:[]});const view=render(<Collections active paused={false} backRef={{current:null}}/>);await screen.findByText('컬렉션이 아직 공유되지 않았습니다');
    mocks.api.mockResolvedValueOnce({...page,items:[]});pull(list());await screen.findByText('아직 작품이 없습니다');
    mocks.api.mockRejectedValueOnce(Object.assign(new Error('요청한 정보를 찾을 수 없습니다.'),{status:404}));pull(list());await screen.findByText(/서버에 모바일 컬렉션 기능이 필요/);view.unmount();
  });
  it('searches after typing pauses or on Enter, and clears explicitly',async()=>{
    render(<Collections active paused={false} backRef={{current:null}}/>);await screen.findByText('밤의 도서관');
    const listPaths=()=>mocks.api.mock.calls.map(([path])=>path as string).filter(path=>path.startsWith('/v1/collections?'));
    fireEvent.change(searchBox(),{target:{value:'밤'}});
    fireEvent.submit(searchBox().closest('form')!);
    await waitFor(()=>expect(listPaths().at(-1)).toContain('q=%EB%B0%A4'));
    expect(screen.getByText('검색 결과')).toBeTruthy();
    // A filtered list hides the Showcase fold: it answers a different question.
    expect(screen.queryByRole('button',{name:/쇼케이스/})).toBeNull();
    fireEvent.click(screen.getByRole('button',{name:'검색어 지우기'}));
    await waitFor(()=>expect(listPaths().at(-1)).not.toContain('q=%EB%B0%A4'));
    expect(searchBox().value).toBe('');
    vi.useFakeTimers();
    try {
      fireEvent.change(searchBox(),{target:{value:'도서'}});
      const before=listPaths().length;
      await act(async()=>{vi.advanceTimersByTime(200);});expect(listPaths()).toHaveLength(before);
      await act(async()=>{vi.advanceTimersByTime(200);});
    } finally {vi.useRealTimers();}
    await waitFor(()=>expect(listPaths().at(-1)).toContain(`q=${encodeURIComponent('도서')}`));
  });
  it('ignores stale type results after a newer selection',async()=>{
    let resolveOld!:(value:CollectionPage)=>void;mocks.api.mockImplementationOnce(()=>new Promise(resolve=>{resolveOld=resolve;}));
    render(<Collections active paused={false} backRef={{current:null}}/>);
    pressTab('만화');await screen.findByText('밤의 도서관');
    await act(async()=>resolveOld({...page,items:[{...item,id:'stale',name:'오래된 게임'}]}));expect(screen.queryByText('오래된 게임')).toBeNull();
  });
  it('shows an AV tab that waits for the PC without requesting an unsupported type',async()=>{
    render(<Collections active paused={false} backRef={{current:null}}/>);await screen.findByText('밤의 도서관');
    expect(screen.getAllByRole('tab').map(tab=>tab.textContent)).toEqual(['게임','만화','영화','AV']);
    const before=mocks.api.mock.calls.length;
    pressTab('AV');
    expect(await screen.findByText('AV 컬렉션은 준비 중입니다')).toBeTruthy();
    await act(async()=>{});
    expect(mocks.api.mock.calls.slice(before).some(([path])=>String(path).includes('type=av'))).toBe(false);
    expect(screen.queryByRole('searchbox')).toBeNull();
  });
  it('closes sheets on Back before leaving the work, and keeps the detail free of list controls',async()=>{
    const backRef:{current:(()=>boolean)|null}={current:null};render(<Collections active paused={false} backRef={backRef}/>);await screen.findByText('밤의 도서관');
    fireEvent.click(screen.getByRole('button',{name:/내 별점/}));
    act(()=>{expect(backRef.current?.()).toBe(true);});expect(screen.queryByRole('dialog')).toBeNull();
    fireEvent.click(screen.getByText('밤의 도서관'));
    await waitFor(()=>expect(document.querySelector('.collection-detail h1')?.textContent).toBe('밤의 도서관'));
    expect(screen.queryByRole('tab',{name:'게임'})).toBeNull();
    expect(screen.getByRole('button',{name:'뒤로'})).toBeTruthy();
    expect(screen.getByText('컬렉션 › 게임')).toBeTruthy();
    expect(screen.getByRole('region',{name:'권별 표지'})).toBeTruthy();
    expect(screen.getByRole('button',{name:'밤의 도서관 표지 감상'})).toBeTruthy();
    // Work information is shown, not hidden behind a disclosure.
    expect(metadataBlock().tagName).toBe('DL');
    act(()=>{expect(backRef.current?.()).toBe(true);});
    expect(screen.queryAllByRole('region',{name:'권별 표지'})).toHaveLength(0);
    expect(screen.getByRole('tab',{name:'게임'})).toBeTruthy();
    act(()=>{expect(backRef.current?.()).toBe(false);});
  });
  it('opens ordered edition covers, requests only the opened original, and backs out one level',async()=>{
    const backRef:{current:(()=>boolean)|null}={current:null};render(<Collections active paused={false} backRef={backRef}/>);
    fireEvent.click(await screen.findByText('밤의 도서관'));
    await screen.findByRole('radio',{name:'기본판'});
    const volumeLabels=()=>within(screen.getByRole('region',{name:'권별 표지'})).getAllByRole('button').filter(button=>button.classList.contains('collection-tile')).map(el=>el.lastElementChild?.textContent);
    expect(volumeLabels()).toEqual(['1권','2권']);
    expect(mocks.native.mock.calls.some(([,payload])=>payload.variant==='original')).toBe(false);
    fireEvent.click(screen.getByText('1권'));await screen.findByRole('dialog');await waitFor(()=>expect(mocks.native).toHaveBeenCalledWith('collectionArtwork',expect.objectContaining({artworkId:'c1',variant:'original',revision:'r1'}),expect.any(AbortSignal)));
    expect(within(screen.getByRole('dialog')).getAllByText('1권')).toHaveLength(1);
    expect(within(screen.getByRole('dialog')).getByText('2 / 3')).toBeTruthy();
    act(()=>{expect(backRef.current?.()).toBe(true);});expect(screen.queryByRole('dialog')).toBeNull();
    fireEvent.click(screen.getByRole('radio',{name:'판본 2'}));expect(screen.queryByText('2권')).toBeNull();expect(screen.getByText('특별판 1권')).toBeTruthy();
    act(()=>{expect(backRef.current?.()).toBe(true);});expect(screen.queryAllByRole('heading',{level:1,name:item.name})).toHaveLength(0);expect(mocks.api.mock.calls.every(([, ,body])=>body===undefined)).toBe(true);
    expect(screen.queryAllByRole('button',{name:/편집|삭제|가져오기|게시/})).toHaveLength(0);
  });
});

it('shows personal and provider metadata, hides manga imported descriptions, and renders TV seasons',async()=>{
 const manga={...item,type:'manga' as const,author:'작가 이름',year:2020,myScore:4.5,genres:'모험',overview:'English provider overview'};
 mocks.api.mockImplementation(async(path:string)=>path.includes('?')?{...page,items:[manga]}:{revision:'r1',item:manga});
 const view=render(<Collections active paused={false} backRef={{current:null}}/>);fireEvent.click(await screen.findByText(item.name));
 await screen.findAllByText('★ 4.5 / 5');expect(screen.queryByText('English provider overview')).toBeNull();expect(screen.getAllByText('모험').length).toBeGreaterThan(0);
 // The detail cover is flat; the viewer opens it as a turnable book and can switch back to flat.
 fireEvent.click(screen.getByRole('button',{name:'밤의 도서관 표지 감상'}));
 const dialog=await screen.findByRole('dialog');
 expect(within(dialog).getByRole('radio',{name:'입체'}).getAttribute('aria-checked')).toBe('true');
 // jsdom has no WebGL2, so the book falls back to the flat cover on its own.
 await waitFor(()=>expect(within(dialog).getByRole('radio',{name:'평면'}).getAttribute('aria-checked')).toBe('true'));
 fireEvent.click(within(dialog).getByRole('radio',{name:'입체'}));
 expect(within(dialog).getByRole('radio',{name:'입체'}).getAttribute('aria-checked')).toBe('true');
 view.unmount();
 const movie={...item,type:'movie',productionCompany:'제작사 이름',externalScore:85,overview:'한국어 줄거리',series:{status:'방영 종료',cast:['출연자'],seasons:[{id:10,seasonNumber:1,name:'시즌 1',airDate:'2020-01-01',posterArtworkId:null,episodes:[{id:20,episodeNumber:1,name:'첫 회',airDate:'2020-01-01',runtimeMinutes:24}]}]}};
 mocks.api.mockImplementation(async(path:string)=>path.includes('?')?{...page,items:[movie]}:{revision:'r1',item:movie});
 render(<Collections active paused={false} backRef={{current:null}}/>);fireEvent.click(await screen.findByText(item.name));await screen.findByText('첫 회');expect(screen.getAllByText('제작사 이름').length).toBeGreaterThan(0);expect(screen.getByText('2020-01-01 · 24분')).toBeTruthy();
 // One season needs no season picker, and its name is not repeated as a second heading.
 expect(screen.queryByRole('group',{name:'시즌'})).toBeNull();expect(screen.getByText('시즌 1개')).toBeTruthy();
 const toggle=screen.getByRole('button',{name:'더 보기'});expect(screen.getByText('한국어 줄거리').classList.contains('is-clamped')).toBe(true);
 fireEvent.click(toggle);expect(screen.getByText('한국어 줄거리').classList.contains('is-clamped')).toBe(false);
});

it('uses production company and TV date range for movie grid captions',()=>{
  const movie={...item,type:'movie' as const,productionCompany:'Studio',director:'Director',year:2016,seasonDateRange:['2016-01-14','2024-05-05']};
  expect(collectionCardCredit(movie)).toBe('Studio');expect(collectionCardDate(movie)).toBe('16.1.14~24.5.5');expect(collectionCardDate({...movie,seasonDateRange:null})).toBe('2016');
});
it('shows the full filtered Collection count instead of the loaded page length',async()=>{
  mocks.api.mockResolvedValue({...page,totalCount:125});render(<Collections active paused={false} backRef={{current:null}}/>);expect((await screen.findByLabelText('필터 결과 개수')).textContent?.trim()).toBe('125');
});
/**
 * jsdom does not lay text out, so the caption rules are asserted on the elements that own them.
 * A long title plus a missing creator is the case that used to change the card's height: the
 * reserved two-line title area is what keeps every card the same size.
 */
it('bounds every card caption without dropping the full work value',async()=>{
  const long={...item,id:'long',name:'아주 길고 긴 한국어 작품 제목이 두 줄을 넘어가는 경우',developer:'매우 길게 이어지는 개발사 이름 예시'};
  mocks.api.mockImplementation(async(path:string)=>path.includes('?')?{...page,items:[long]}:{revision:'r1',item:long});
  render(<Collections active paused={false} backRef={{current:null}}/>);await screen.findByText(long.name);
  const card=section().querySelector('.collection-grid .collection-tile') as HTMLElement;
  const title=card.querySelector('.collection-title') as HTMLElement, credit=card.querySelector('.collection-credit') as HTMLElement;
  expect(title.className).toBe('collection-title');
  expect(credit.className).toBe('collection-credit');
  // The full values are rendered; no tooltip substitutes for the truncated text.
  expect(title.textContent).toBe(long.name);
  expect(credit.textContent).toBe(long.developer);
  expect(title.getAttribute('title')).toBeNull();
  expect(credit.getAttribute('aria-description')).toBeNull();
  expect(card.getAttribute('aria-label')).toBeNull();
  // The same full-value rule holds on the detail surface the card opens.
  fireEvent.click(screen.getByText(long.name));
  expect((await screen.findByRole('heading',{level:1,name:long.name})).textContent).toBe(long.name);
  expect(metadataBlock().textContent).toContain(long.developer);
});
/** The detail identity names each type's own maker role, so the grid caption never has to. */
it.each([['game','개발사','아주 긴 개발사 이름'],['manga','작가','아주 긴 작가 이름'],['movie','제작사','아주 긴 제작사 이름']] as const)('names the %s maker role in the detail identity',async(type,role,name)=>{
  const fields=type==='game'?{developer:name}:type==='manga'?{author:name}:{productionCompany:name};
  const work={...item,...fields,type};
  mocks.api.mockImplementation(async(path:string)=>path.includes('?')?{...page,items:[work]}:{revision:'r1',item:work});
  render(<Collections active paused={false} backRef={{current:null}}/>);
  fireEvent.click(await screen.findByText(item.name));
  expect(await screen.findByText(`${role} · ${name}`)).toBeTruthy();
  expect(metadataBlock().textContent).toContain(name);
});

it('shows each volume release date beside its number when the publication has one',async()=>{
  const dated:CollectionDetail={...item,volumes:[{id:'d1',volumeNumber:1,editionIndex:0,displayLabel:'1',coverArtworkId:'c1',localReleaseDate:'2024-03-05'},{id:'d2',volumeNumber:2,editionIndex:0,displayLabel:'2',coverArtworkId:'c2',localReleaseDate:null}]};
  mocks.api.mockImplementation(async(path:string)=>path.includes('?')?page:{revision:'r1',item:dated});
  render(<Collections active paused={false} backRef={{current:null}}/>);fireEvent.click(await screen.findByText(item.name));
  const region=await screen.findByRole('region',{name:'권별 표지'});
  const labels=[...region.querySelectorAll('.collection-tile>span:last-child')].map(el=>el.textContent);
  expect(labels).toEqual(['1권 · 2024.3.5','2권']);
  fireEvent.click(region.querySelector('.collection-tile')!);
  expect(within(await screen.findByRole('dialog')).getByText('1권 · 2024.3.5')).toBeTruthy();
});
