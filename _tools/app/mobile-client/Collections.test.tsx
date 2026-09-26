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
/** Search lives behind the top bar's magnifier; open it once, then use the field. */
const searchBox=()=>{if(!screen.queryByRole('searchbox',{name:'컬렉션 검색'}))fireEvent.click(screen.getByRole('button',{name:'검색'}));return screen.getByRole('searchbox',{name:'컬렉션 검색'}) as HTMLInputElement;};
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
      if(path.startsWith('/v1/collections/releases'))return Promise.resolve({revision:1,counts:{unread:0,collections:[]},items:[],nextCursor:null,hasMore:false});
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

  it('retries failed artwork on return, and reloads a changed digest, and keeps the image across a revision-only change',async()=>{
    let work={...item,artworkVersions:{cover:{thumbnail:'digest-1'}}},revision='r1';
    mocks.api.mockImplementation(async(path:string)=>path.endsWith('/status')?{revision}:{...page,revision,items:[work]});
    mocks.native.mockRejectedValueOnce(new Error('media offline')).mockImplementation(async(_op,payload)=>({url:`https://example.invalid/${payload.revision}-${payload.digest}`}));
    const props={active:true,paused:false,backRef:{current:null}};const view=render(<Collections {...props}/>);
    // The failure schedules a timed retry; returning to the tab first retries at once and cancels it.
    await waitFor(()=>expect(artworkCalls('cover')).toHaveLength(1));await act(async()=>{});
    view.rerender(<Collections {...props} active={false}/>);view.rerender(<Collections {...props}/>);
    const image=await screen.findByRole('img',{name:item.name});expect(artworkCalls('cover')).toHaveLength(2);
    fireEvent.error(image);view.rerender(<Collections {...props} paused/>);view.rerender(<Collections {...props}/>);
    await screen.findByRole('img',{name:item.name});expect(artworkCalls('cover')).toHaveLength(3);
    work={...work,artworkVersions:{cover:{thumbnail:'digest-2'}}};pull(list());
    await waitFor(()=>expect(screen.getByRole('img',{name:item.name}).getAttribute('src')).toContain('digest-2'));
    expect(artworkCalls('cover')).toHaveLength(4);
    // A new publication revision with the same digest is the same image: no new ticket, same element.
    const current=screen.getByRole('img',{name:item.name});
    const reads=listCalls().length;revision='r2';pull(list());
    await waitFor(()=>expect(listCalls().length).toBeGreaterThan(reads));await act(async()=>{});
    expect(screen.getByRole('img',{name:item.name})).toBe(current);
    expect(current.getAttribute('src')).toContain('r1-digest-2');
    expect(artworkCalls('cover')).toHaveLength(4);
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

describe('visible artwork retries',()=>{
  const coverCalls=()=>mocks.native.mock.calls.filter(([op,payload])=>op==='collectionArtwork'&&payload.artworkId==='cover');
  const advance=(ms=0)=>act(async()=>{await vi.advanceTimersByTimeAsync(ms);});
  const broken=()=>screen.queryByText('이미지를 불러오지 못했습니다');
  const cover=()=>screen.queryByRole('img',{name:item.name});
  /** The native reply for a full media queue: the request never started. */
  const busy=()=>Object.assign(new Error('요청이 많습니다. 잠시 후 다시 시도해 주세요.'),{status:null,details:{code:'media_busy'}});
  const props={active:true,paused:false,backRef:{current:null}};
  beforeEach(()=>{vi.useFakeTimers();});
  afterEach(()=>{cleanup();vi.useRealTimers();});

  it('shows a cover that failed once without a tab change',async()=>{
    mocks.native.mockRejectedValueOnce(new Error('media offline'));
    render(<Collections {...props}/>);await advance();
    expect(coverCalls()).toHaveLength(1);expect(cover()).toBeNull();expect(broken()).toBeNull();
    await advance(999);expect(coverCalls()).toHaveLength(1);
    await advance(1);expect(coverCalls()).toHaveLength(2);
    expect(cover()?.getAttribute('src')).toBe('https://example.invalid/cover');
    await advance(60_000);expect(coverCalls()).toHaveLength(2);
  });

  it('retries a full native queue without showing the cover as broken',async()=>{
    mocks.native.mockRejectedValueOnce(busy()).mockRejectedValueOnce(busy());
    render(<Collections {...props}/>);await advance();
    expect(coverCalls()).toHaveLength(1);expect(broken()).toBeNull();
    await advance(2000);expect(coverCalls()).toHaveLength(2);expect(broken()).toBeNull();
    await advance(2000);expect(coverCalls()).toHaveLength(3);
    expect(cover()).not.toBeNull();expect(broken()).toBeNull();
  });

  it.each([
    ['failure',()=>new Error('media offline'),4],
    ['full queue',busy,14],
  ] as const)('bounds the retries of a %s, then waits for a tab change',async(_kind,error,calls)=>{
    mocks.native.mockImplementation(async()=>{throw error();});
    const view=render(<Collections {...props}/>);await advance();
    for(let second=0;second<120;second++)await advance(1000);
    expect(coverCalls()).toHaveLength(calls);expect(broken()).not.toBeNull();
    await advance(30*60_000);expect(coverCalls()).toHaveLength(calls);
    // Returning to the tab starts a fresh budget.
    view.rerender(<Collections {...props} active={false}/>);view.rerender(<Collections {...props}/>);await advance();
    expect(coverCalls()).toHaveLength(calls+1);
  });

  it('cancels a pending retry when the cover scrolls away or unmounts',async()=>{
    const observers:{callback:IntersectionObserverCallback;element?:Element}[]=[];
    vi.stubGlobal('IntersectionObserver',class {
      entry:{callback:IntersectionObserverCallback;element?:Element};
      constructor(callback:IntersectionObserverCallback){this.entry={callback};observers.push(this.entry);}
      observe(element:Element){this.entry.element=element;}
      disconnect(){} unobserve(){} takeRecords(){return [];}
    });
    const show=(visible:boolean)=>act(async()=>{for(const {callback,element} of observers)if(element)callback([{isIntersecting:visible,target:element} as IntersectionObserverEntry],{} as IntersectionObserver);});
    mocks.native.mockRejectedValue(new Error('media offline'));
    const view=render(<Collections {...props}/>);await advance();await show(true);await advance();
    expect(coverCalls()).toHaveLength(1);
    await show(false);await advance(60_000);expect(coverCalls()).toHaveLength(1);
    await show(true);await advance();expect(coverCalls()).toHaveLength(2);
    view.unmount();await advance(60_000);expect(coverCalls()).toHaveLength(2);
  });
});

describe('read-only collections',()=>{
  it('sorts and filters the server list from chips, restarts the scroll and keeps per-type choices',async()=>{
    mocks.api.mockResolvedValue({...page,nextCursor:'page-2'});
    render(<Collections active paused={false} backRef={{current:null}}/>);await screen.findByText('밤의 도서관');
    scrollToEnd(list());
    await waitFor(()=>expect(mocks.api.mock.calls.at(-1)?.[0]).toContain('cursor=page-2'));
    fireEvent.click(screen.getByRole('button',{name:/내 별점/}));
    // A slider (전체, 0.5 … 5.0) with 전체 marked as the default, plus a separate 미평가 toggle.
    const slider=within(screen.getByRole('dialog')).getByRole('slider',{name:'내 별점'}) as HTMLInputElement;
    expect(slider.getAttribute('aria-valuetext')).toBe('전체 · 기본');expect(slider.max).toBe('10');
    fireEvent.change(slider,{target:{value:'9'}});expect(slider.getAttribute('aria-valuetext')).toBe('★ 4.5');
    await waitFor(()=>expect(mocks.api.mock.calls.at(-1)?.[0]).toContain('rating=4.5'));
    expect(mocks.api.mock.calls.at(-1)?.[0]).not.toContain('cursor=');
    fireEvent.click(within(screen.getByRole('dialog')).getByRole('button',{name:'미평가만'}));
    await waitFor(()=>expect(mocks.api.mock.calls.at(-1)?.[0]).toContain('rating=unrated'));
    expect(within(screen.getByRole('dialog')).getByRole('button',{name:'미평가만'}).getAttribute('aria-pressed')).toBe('true');
    fireEvent.change(slider,{target:{value:'9'}});
    await waitFor(()=>expect(mocks.api.mock.calls.at(-1)?.[0]).toContain('rating=4.5'));
    expect(within(screen.getByRole('dialog')).getByRole('button',{name:'미평가만'}).getAttribute('aria-pressed')).toBe('false');
    fireEvent.click(within(screen.getByRole('dialog')).getByRole('button',{name:'닫기'}));
    expect(screen.queryByRole('dialog')).toBeNull();
    fireEvent.click(screen.getByRole('button',{name:'최신순'}));
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
  it('keeps the type switch in the list bar, including while searching, and not in the scrolled list',async()=>{
    render(<Collections active paused={false} backRef={{current:null}}/>);await screen.findByText('밤의 도서관');
    const switcher=()=>screen.getByRole('tablist',{name:'컬렉션 유형'});
    expect(switcher().closest('header.top-bar')).toBeTruthy();
    // Underline text tabs (centred by CSS), no longer the segmented control.
    expect(switcher().classList.contains('collection-type-tabs')).toBe(true);
    expect(switcher().classList.contains('library-segments')).toBe(false);
    expect(list().querySelector('[role=tablist]')).toBeNull();
    expect(screen.getAllByRole('tablist',{name:'컬렉션 유형'})).toHaveLength(1);
    const listPaths=()=>mocks.api.mock.calls.map(([path])=>path as string).filter(path=>path.startsWith('/v1/collections?'));
    fireEvent.change(searchBox(),{target:{value:'밤'}});fireEvent.submit(searchBox().closest('form')!);
    await waitFor(()=>expect(listPaths().at(-1)).toContain('q=%EB%B0%A4'));
    expect(switcher().closest('header.top-bar.is-search')).toBeTruthy();
    // Switching type still clears the query, as it did from the list.
    pressTab('만화');
    await waitFor(()=>expect(listPaths().at(-1)).toContain('type=manga'));
    expect(listPaths().at(-1)).toContain('q=&');
    expect(searchBox().value).toBe('');
    expect(screen.getByRole('tab',{name:'만화'}).getAttribute('aria-selected')).toBe('true');
    expect(screen.getByRole('tab',{name:'게임'}).getAttribute('aria-selected')).toBe('false');
  });
  it('swaps the list sideways toward the chosen type only once its page commits, and glides one underline',async()=>{
    const animate=vi.fn(()=>({cancel(){}}));(HTMLElement.prototype as unknown as {animate:unknown}).animate=animate;
    try{
      render(<Collections active paused={false} backRef={{current:null}}/>);await screen.findByText('밤의 도서관');
      expect(animate).not.toHaveBeenCalled();
      const switcher=screen.getByRole('tablist',{name:'컬렉션 유형'});
      expect(switcher.querySelectorAll('.collection-type-indicator')).toHaveLength(1);
      let resolveManga!:(value:CollectionPage)=>void;
      mocks.api.mockImplementation((path:string)=>path.includes('type=manga')&&!path.includes('showcase=true')?new Promise(resolve=>{resolveManga=resolve;}):Promise.resolve(page));
      pressTab('만화');await act(async()=>{});
      // Still loading: the game list stays put rather than sliding in stale.
      expect(animate).not.toHaveBeenCalled();
      await act(async()=>resolveManga({...page,items:[{...item,id:'manga-2',type:'manga',name:'새 만화'}]}));
      await screen.findByText('새 만화');
      const moves=animate.mock.calls as unknown as [Keyframe[],KeyframeAnimationOptions][];
      expect(moves).toHaveLength(1);
      expect((animate.mock.contexts as HTMLElement[])[0]).toBe(list());
      expect(moves[0][0][0].transform).toBe('translateX(14px)');
      // AV lies to the right as well; back to 게임 comes in from the left.
      pressTab('AV');await screen.findByText('AV 컬렉션은 준비 중입니다');
      expect(moves.at(-1)![0][0].transform).toBe('translateX(14px)');
      pressTab('게임');await screen.findByText('밤의 도서관');
      await waitFor(()=>expect(moves.at(-1)![0][0].transform).toBe('translateX(-14px)'));
    }finally{delete (HTMLElement.prototype as unknown as {animate?:unknown}).animate;}
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

describe('film details',()=>{
  const film={cast:[{name:'배우 가',character:'주인공'},{name:'배우 나',character:''}],
    releases:[{country:'US',releaseType:3,date:'2024-01-01',certification:'PG-13'},{country:'KR',releaseType:3,date:'2024-02-03',certification:'15'},{country:'JP',releaseType:4,date:'2024-05-01',certification:''}],
    related:{collectionName:'사가 컬렉션',parts:[{movieId:3,title:'속편',releaseDate:'2026-01-01'},{movieId:2,title:'전편',releaseDate:'2020-01-01'}]}};
  const open=async(detail:CollectionDetail)=>{
    mocks.api.mockImplementation(async(path:string)=>path.includes('?')?{...page,items:[detail]}:{revision:'r1',item:detail});
    render(<Collections active paused={false} backRef={{current:null}}/>);fireEvent.click(await screen.findByText(detail.name));
    await screen.findByLabelText('작품 정보',{selector:'dl'});
  };
  it('shows cast, KR plus earliest releases with a full-list toggle, and unlinked related works',async()=>{
    await open({...item,type:'movie',film});
    const cast=screen.getByRole('region',{name:'출연'});
    expect(within(cast).getByText('배우 가')).toBeTruthy();expect(within(cast).getByText('주인공')).toBeTruthy();
    const releases=screen.getByRole('region',{name:'개봉 정보'});
    expect(within(releases).getAllByRole('listitem').map(row=>row.textContent)).toEqual(['2024.01.01미국 · 극장 개봉 · PG-13','2024.02.03한국 · 극장 개봉 · 15']);
    const toggle=within(releases).getByRole('button',{name:'전체 보기'});fireEvent.click(toggle);
    expect(toggle.getAttribute('aria-expanded')).toBe('true');expect(within(releases).getAllByRole('listitem')).toHaveLength(3);
    expect(within(releases).getByText('일본 · 디지털')).toBeTruthy();
    const related=screen.getByRole('region',{name:'관련 작품'});
    expect(within(related).getByText('사가 컬렉션')).toBeTruthy();
    expect(within(related).getAllByRole('listitem').map(row=>row.querySelector('strong')?.textContent)).toEqual(['전편','속편']);
    expect(within(related).queryByRole('button')).toBeNull();
  });
  it('renders nothing extra for an older publication without film details',async()=>{
    await open({...item,type:'movie'});
    for(const name of ['출연','개봉 정보','관련 작품'])expect(screen.queryByRole('region',{name})).toBeNull();
  });
  it('hides the release toggle when every release is already shown',async()=>{
    await open({...item,type:'movie',film:{cast:[],releases:[film.releases[1]],related:null}});
    expect(screen.queryByRole('region',{name:'출연'})).toBeNull();expect(screen.queryByRole('region',{name:'관련 작품'})).toBeNull();
    expect(within(screen.getByRole('region',{name:'개봉 정보'})).queryByRole('button')).toBeNull();
  });
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
  // Manga shows its facts beside the cover and does not repeat the maker in a second section.
  if(type==='manga')expect(screen.queryByRole('region',{name:'작품 정보 영역'})).toBeNull();
  else expect(metadataBlock().textContent).toContain(name);
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

it('shows a manga 원제 small under the title only when it differs from the title',async()=>{
  const open=async(detail:CollectionDetail)=>{
    mocks.api.mockImplementation(async(path:string)=>path.includes('?')?{...page,items:[detail]}:{revision:'r1',item:detail});
    const view=render(<Collections active paused={false} backRef={{current:null}}/>);fireEvent.click(await screen.findByText(detail.name));
    await screen.findByRole('heading',{level:1,name:detail.name});
    return view;
  };
  const manga:CollectionDetail={...item,type:'manga',originalTitle:'夜の図書館'};
  let view=await open(manga);
  const line=document.querySelector('.collection-detail-identity h1 + .collection-detail-original');
  expect(line?.textContent).toBe('夜の図書館');
  view.unmount();
  for(const originalTitle of [null,'  ',' 밤의 도서관 ']){
    view=await open({...manga,originalTitle});
    expect(document.querySelector('.collection-detail-original')).toBeNull();
    view.unmount();
  }
});
describe('type switch continuity',()=>{
  const game=item,manga:CollectionDetail={...item,id:'manga-2',type:'manga',name:'새 만화',selectedWorkArtworkId:'manga-cover'};
  const movie:CollectionDetail={...item,id:'movie-3',type:'movie',name:'새 영화',selectedWorkArtworkId:'movie-cover'};
  const listCalls=(type:string)=>mocks.api.mock.calls.filter(([path])=>String(path).startsWith(`/v1/collections?type=${type}&`)&&!String(path).includes('showcase=true'));
  const coverCalls=(id:string)=>mocks.native.mock.calls.filter(([op,payload])=>op==='collectionArtwork'&&payload.artworkId===id);
  const grid=()=>list().querySelector('.collection-grid') as HTMLElement;
  const serve=(pages:Record<string,CollectionPage|Promise<CollectionPage>>)=>mocks.api.mockImplementation(async(path:string)=>{
    const type=/type=(\w+)/.exec(path)?.[1];
    return path.startsWith('/v1/collections?')&&type&&pages[type]?pages[type]:path.endsWith('/status')?{revision:'r1'}:page;
  });

  it('keeps the previous type on screen until the new page commits, never an empty or placeholder grid',async()=>{
    let resolveManga!:(value:CollectionPage)=>void;
    serve({game:page,manga:new Promise<CollectionPage>(resolve=>{resolveManga=resolve;})});
    render(<Collections active paused={false} backRef={{current:null}}/>);await screen.findByText(game.name);
    const seen:{tiles:number;placeholders:number;type:string}[]=[];
    const observer=new MutationObserver(()=>{const node=grid();seen.push({tiles:node.querySelectorAll('.collection-tile').length,placeholders:node.querySelectorAll('.collection-art-placeholder').length,type:node.className});});
    observer.observe(list(),{subtree:true,childList:true,attributes:true});
    pressTab('만화');await act(async()=>{});
    // Loading: the game cards stay, laid out as the game grid they are.
    expect(screen.getByText(game.name)).toBeTruthy();
    expect(grid().className).toContain('collection-grid-game');
    await act(async()=>resolveManga({...page,items:[manga]}));
    await screen.findByText(manga.name);
    observer.disconnect();
    expect(grid().className).toContain('collection-grid-manga');
    expect(seen.length).toBeGreaterThan(0);
    expect(seen.every(frame=>frame.tiles>0)).toBe(true);
    // The first screen's covers were readied before the swap: they are there in the commit.
    expect(seen.every(frame=>frame.placeholders===0)).toBe(true);
    expect(screen.getByRole('img',{name:manga.name}).classList.contains('collection-art-arrive')).toBe(false);
    expect(coverCalls('manga-cover')).toHaveLength(1);
  });

  it('shows a type switched back to from memory without a request until a newer revision is read',async()=>{
    serve({game:page,manga:{...page,items:[manga]},movie:{...page,revision:'r2',items:[movie]}});
    render(<Collections active paused={false} backRef={{current:null}}/>);await screen.findByText(game.name);
    pressTab('만화');await screen.findByText(manga.name);
    const games=listCalls('game').length,mangas=listCalls('manga').length,gameCovers=coverCalls('cover').length;
    pressTab('게임');
    await act(async()=>{});
    expect(screen.getByText(game.name)).toBeTruthy();expect(screen.queryByText(manga.name)).toBeNull();
    pressTab('만화');await act(async()=>{});
    expect(screen.getByText(manga.name)).toBeTruthy();
    expect(listCalls('game')).toHaveLength(games);expect(listCalls('manga')).toHaveLength(mangas);
    expect(coverCalls('cover')).toHaveLength(gameCovers);
    // 영화 was read under a newer publication: the remembered 게임 list shows at once and re-reads quietly.
    pressTab('영화');await screen.findByText(movie.name);
    let resolveGame!:(value:CollectionPage)=>void;
    serve({game:new Promise<CollectionPage>(resolve=>{resolveGame=resolve;})});
    pressTab('게임');await act(async()=>{});
    expect(screen.getByText(game.name)).toBeTruthy();
    expect(list().querySelector('.loading-line')).toBeNull();
    expect(listCalls('game')).toHaveLength(games+1);
    await act(async()=>resolveGame({...page,revision:'r2',items:[{...game,name:'갱신된 게임'}]}));
    expect(await screen.findByText('갱신된 게임')).toBeTruthy();
  });

  it('fades in a cover that arrives after its card, not one this screen already decoded',async()=>{
    serve({game:page,manga:{...page,items:[manga]}});
    render(<Collections active paused={false} backRef={{current:null}}/>);await screen.findByText(game.name);
    expect((await screen.findByRole('img',{name:game.name})).classList.contains('collection-art-arrive')).toBe(true);
    pressTab('만화');await screen.findByText(manga.name);
    pressTab('게임');await screen.findByText(game.name);
    expect(screen.getByRole('img',{name:game.name}).classList.contains('collection-art-arrive')).toBe(false);
  });
});
