import {workImageLoads} from './workImageLoads.test-helper';
import {act, cleanup, fireEvent, render, screen, waitFor, within} from '@testing-library/react';
import {afterEach, beforeEach, describe, expect, it, vi} from 'vitest';
import {collectionCardCredit, collectionCardDate, collectionPath, coverFocuses, editionVolumes, editions} from './collectionModel';
import type {CollectionDetail, CollectionPage} from './collectionModel';
const mocks=vi.hoisted(()=>({api:vi.fn(),native:vi.fn()}));
vi.mock('./transport',()=>({api:mocks.api,native:mocks.native,errorText:(reason:unknown)=>String(reason)}));
vi.mock('./media',()=>({mediaTicket:vi.fn()}));
import {Collections} from './Collections';
import {resetReleaseStore} from './releaseStore';
import {resetMangaShelfDetails, TabletMangaShelf} from './CollectionMangaShelf';
const item:CollectionDetail={id:'manga-1',name:'밤의 도서관',type:'game',showcase:true,selectedWorkArtworkId:'cover',volumes:[{id:'v2',volumeNumber:2,editionIndex:0,displayLabel:'2권',coverArtworkId:'c2'},{id:'e1',volumeNumber:1,editionIndex:1,displayLabel:'특별판 1권',coverArtworkId:'e1'},{id:'v1',volumeNumber:1,editionIndex:0,displayLabel:'1',coverArtworkId:'c1'}],artworks:[]};
const page:CollectionPage={ready:true,filterVersion:1,revision:'r1',publishedAt:null,items:[item],nextCursor:null};
const section=()=>screen.getByLabelText('컬렉션',{selector:'section'});
const list=()=>section().querySelector('.collection-scroll') as HTMLElement;
const detailPane=()=>section().querySelector('.collection-detail') as HTMLElement;
async function finishIncomingWork() {
  await waitFor(()=>expect(document.querySelector('[data-work-pending] img')).not.toBeNull());
  await act(async()=>{document.querySelectorAll('[data-work-pending] img').forEach(image=>fireEvent.load(image));});
}
/** Finish the native rise before exercising the deferred Showcase body. */
const pressShowcase=(button:HTMLElement)=>{
  fireEvent.click(button);
  const panel=screen.getByRole('dialog',{name:'쇼케이스'});
  fireEvent(panel,Object.assign(new Event('transitionend',{bubbles:true}),{propertyName:'translate'}));
};
const pressTab=(name:string)=>fireEvent.click(screen.getByRole('radio',{name}));
/** Search lives behind the top bar's magnifier; open it once, then use the field. */
const searchBox=()=>{if(!screen.queryByRole('searchbox',{name:'컬렉션 검색'}))fireEvent.click(screen.getByRole('button',{name:'검색'}));return screen.getByRole('searchbox',{name:'컬렉션 검색'}) as HTMLInputElement;};
/** A downward pull from the top of a scroller is the refresh gesture. */
function pull(element:HTMLElement){fireEvent.touchStart(element,{touches:[{clientX:0,clientY:0}]});fireEvent.touchMove(element,{touches:[{clientX:0,clientY:200}]});fireEvent.touchEnd(element);}
/** jsdom has no layout, so the scroller's geometry is declared before the scroll event. */
function scrollToEnd(element:HTMLElement){Object.defineProperty(element,'clientHeight',{configurable:true,value:500});Object.defineProperty(element,'scrollHeight',{configurable:true,value:600});element.scrollTop=100;fireEvent.scroll(element);}
const metadataBlock=()=>screen.getByRole('region',{name:'작품 정보'}).querySelector('dl') as HTMLElement;
/** The fixture as a manga, which opens on the shared book and bookcase instead of the case. */
const mangaItem=():CollectionDetail=>({...item,type:'manga'});
const bookcaseLabels=()=>within(screen.getByRole('group',{name:'권별 책장'})).getAllByRole('button').map(button=>button.getAttribute('aria-label'));
beforeEach(()=>{localStorage.clear();for(const kind of ['game','manga','movie','av'])localStorage.setItem(`lakomics.mobile.collectionView.${kind}.v1`,JSON.stringify({layout:'grid',perRow:4}));resetReleaseStore();resetMangaShelfDetails();mocks.api.mockReset();mocks.native.mockReset();mocks.api.mockImplementation(async(path:string)=>path.includes('type=av')?{...page,items:[]}:path.includes('/v1/collections/')?{revision:'r1',item}:page);mocks.native.mockResolvedValue({url:'https://example.invalid/cover',expires_in:300});});
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
    const work:CollectionDetail={...mangaItem(),selectedHeroArtworkId:'hero',artworks:[{id:'hero',kind:'hero',selected:true,thumbnailAvailable:true,originalAvailable:true}],volumes:[...item.volumes,...Array.from({length:100},(_,i)=>({id:`extra-${i}`,volumeNumber:i+2,editionIndex:1,displayLabel:`특별판 ${i+2}권`}))]};
    mocks.api.mockImplementation(async(path:string)=>path.endsWith('/status')?{revision:'r1'}:path.includes('showcase=true')?{...page,items:[]}:path.startsWith('/v1/collections?')?page:{revision:'r1',item:work});
    const decode=vi.fn().mockResolvedValue(undefined);
    vi.stubGlobal('Image',class {src='';decode=decode;});
    const props={active:true,paused:false,backRef:{current:null}};
    const view=render(<Collections {...props}/>);fireEvent.click(await screen.findByText(item.name));
    fireEvent.click(await screen.findByRole('radio',{name:'판본 2'}));
    await finishIncomingWork();
    const hero=document.querySelector('.tablet-work > div[aria-hidden="false"] .work-hero-band img');
    view.rerender(<Collections {...props} active={mode!=='inactive'} paused={mode==='paused'}/>);
    view.rerender(<Collections {...props}/>);await act(async()=>{});
    expect(listCalls()).toHaveLength(1);expect(detailCalls()).toHaveLength(1);
    expect(screen.getByRole('radio',{name:'판본 2'}).getAttribute('aria-checked')).toBe('true');
    expect(bookcaseLabels()).toHaveLength(101);
    expect(document.querySelector('.tablet-work > div[aria-hidden="false"] .work-hero-band img')).toBe(hero);
    expect(artworkCalls('hero','original').length).toBeGreaterThan(0);expect(decode).toHaveBeenCalled();
  });

  it('prefetches the next page, retains it on return and restarts after a query change',async()=>{
    mocks.api.mockImplementation(async(path:string)=>path.endsWith('/status')?{revision:'r1'}:path.includes('type=manga')?{...page,items:[mangaItem()]}:path.includes('cursor=')?{...page,nextCursor:null,items:[{...item,id:'second',name:'Second page'}]}:{...page,nextCursor:'page-2'});
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
    const next=Promise.withResolvers<CollectionPage>();let firsts=0;
    mocks.api.mockImplementation(async(path:string)=>path.endsWith('/status')?{revision:'r1'}:path.includes('showcase=true')?{...page,items:[]}:path.includes('cursor=')?next.promise:++firsts===1?{...page,nextCursor:'page-2'}:{...page,revision:'r2'});
    render(<Collections active paused={false} backRef={{current:null}}/>);await screen.findByText(item.name);
    await waitFor(()=>expect(listCalls()).toHaveLength(2));
    await act(async()=>next.resolve({...page,revision:'r2',nextCursor:'page-3',items:[{...item,id:'x',name:'mixed'}]}));
    await waitFor(()=>expect(listCalls()).toHaveLength(3));
    expect(listCalls().at(-1)?.[0]).not.toContain('cursor=');expect(screen.queryByText('mixed')).toBeNull();
    expect(screen.getByText(item.name)).toBeTruthy();
  });

  it('does not start requests while initially paused and resumes interrupted list/detail loads',async()=>{
    const props={active:true,paused:false,backRef:{current:null}};
    const oldList=Promise.withResolvers<CollectionPage>(),oldDetail=Promise.withResolvers<{revision:string;item:CollectionDetail}>();
    let lists=0,details=0;
    mocks.api.mockImplementation((path:string)=>{
      if(path.endsWith('/status'))return Promise.resolve({revision:'r1'});
      if(path==='/v1/home/upcoming')return Promise.resolve({entries:[],wishlist:[]});
      if(path.startsWith('/v1/collections/releases'))return Promise.resolve({revision:1,counts:{unread:0,collections:[]},items:[],nextCursor:null,hasMore:false});
      if(path.startsWith('/v1/collections?')&&path.includes('showcase=true'))return Promise.resolve(page);
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
    const view=render(<Collections {...props}/>);await screen.findAllByText(/list offline/);failList=false;
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

  it('shows the hero band from the original and reloads it when its digest or availability changes',async()=>{
    let work:CollectionDetail={...item,selectedHeroArtworkId:'hero',artworkVersions:{hero:{original:'one'}},artworks:[{id:'hero',kind:'hero',selected:true,thumbnailAvailable:true,originalAvailable:true}]};
    mocks.api.mockImplementation(async(path:string)=>path.endsWith('/status')?{revision:'r1'}:path.startsWith('/v1/collections?')?page:{revision:'r1',item:work});
    mocks.native.mockImplementation(async(_op,payload)=>({url:`https://example.invalid/${payload.artworkId}-${payload.variant}-${payload.digest}`}));
    render(<Collections active paused={false} backRef={{current:null}}/>);
    fireEvent.click(await screen.findByText(item.name));
    const band=()=>document.querySelector('.tablet-work > div[aria-hidden="false"] .work-hero-band img')?.getAttribute('src');
    await waitFor(()=>expect(band()).toBe('https://example.invalid/hero-original-one'));
    work={...work,artworkVersions:{hero:{original:'two'}}};pull(detailPane());
    await finishIncomingWork();
    await waitFor(()=>expect(band()).toContain('-two'));
    // A hero published without its original falls back to its thumbnail.
    work={...work,artworks:work.artworks.map(art=>({...art,originalAvailable:false}))};pull(detailPane());
    await waitFor(()=>expect(document.querySelector('[data-work-pending] .work-hero-band img')?.getAttribute('src')).toContain('hero-thumbnail'));
    await finishIncomingWork();
    await waitFor(()=>expect(band()).toContain('hero-thumbnail'));
  });
});

describe('background collection pages',()=>{
  const second={...item,id:'second',name:'Second page'},third={...item,id:'third',name:'Third page'};
  const props={active:true,paused:false,backRef:{current:null}};
  const calls=(showcase=false)=>mocks.api.mock.calls.filter(([path])=>path.startsWith('/v1/collections?')&&path.includes('showcase=true')===showcase);
  const serve=(reply:(url:URL,signal:AbortSignal)=>CollectionPage|Promise<CollectionPage>)=>mocks.api.mockImplementation(async(path:string,signal:AbortSignal)=>{
    if(path.startsWith('/v1/collections?'))return reply(new URL(path,'https://example.invalid'),signal);
    return path.endsWith('/status')?{revision:'r1'}:page;
  });

  it.each([['main',false],['Showcase',true]] as const)('drains %s pages after the first screen commits, appends once and remembers the complete slot',async(_label,showcase)=>{
    const next=Promise.withResolvers<CollectionPage>(),last=Promise.withResolvers<CollectionPage>();
    serve((url)=>{
      if(url.searchParams.get('type')!=='game'||(url.searchParams.get('showcase')==='true')!==showcase)return {...page,items:[]};
      const cursor=url.searchParams.get('cursor');
      if(!cursor)return {...page,nextCursor:'page-2'};
      // No cursor request may start before the first page is actually in the DOM.
      if(!showcase)expect(screen.queryAllByRole('button',{name:new RegExp(item.name)}).length).toBeGreaterThan(0);
      return cursor==='page-2'?next.promise:last.promise;
    });
    render(<Collections {...props}/>);
    await waitFor(()=>expect(calls(showcase)).toHaveLength(2));
    if(showcase)pressShowcase(screen.getByRole('button',{name:/^쇼케이스(?: \d+)?$/}));
    const host=showcase?section().querySelectorAll<HTMLElement>('.collection-scroll')[1]:list();host.scrollTop=140;
    expect(calls(showcase)).toHaveLength(2);
    await act(async()=>next.resolve({...page,items:[second,item],nextCursor:'page-3'}));
    expect(calls(showcase)).toHaveLength(3);
    expect(screen.queryByText(second.name)).toBeNull();
    expect(screen.queryAllByRole('button',{name:new RegExp(item.name)}).length).toBeGreaterThan(0);
    await act(async()=>last.resolve({...page,items:[third,second]}));
    await within(host).findByText(third.name);
    expect(within(host).getAllByText(second.name)).toHaveLength(1);
    expect(host.scrollTop).toBe(140);
    expect(calls(showcase).map(([path])=>new URL(path,'https://example.invalid').searchParams.get('cursor'))).toEqual([null,'page-2','page-3']);
    if(showcase)fireEvent.click(screen.getByRole('button',{name:'쇼케이스 닫기'}));
    pressTab('만화');await act(async()=>{});
    pressTab('게임');if(showcase)pressShowcase(screen.getByRole('button',{name:/^쇼케이스(?: \d+)?$/}));await screen.findByRole('button',{name:new RegExp(third.name)});
    expect(calls(showcase).filter(([path])=>path.includes('type=game'))).toHaveLength(3);
  });

  it('aborts on a key change and ignores an abandoned response without blanking the shown list',async()=>{
    const next=Promise.withResolvers<CollectionPage>(),manga=Promise.withResolvers<CollectionPage>();
    serve(url=>(url.searchParams.get('showcase')==='true')?{...page,items:[]}:url.searchParams.get('type')==='manga'?manga.promise:url.searchParams.has('cursor')?next.promise:{...page,nextCursor:'page-2'});
    render(<Collections {...props}/>);
    await waitFor(()=>expect(calls()).toHaveLength(2));
    const signal=calls()[1][1] as AbortSignal;
    pressTab('만화');expect(signal.aborted).toBe(true);
    expect(screen.getByText(item.name)).toBeTruthy();
    await act(async()=>next.resolve({...page,items:[second],nextCursor:'page-3'}));
    expect(screen.queryByText(second.name)).toBeNull();
    expect(calls().some(([path])=>path.includes('page-3'))).toBe(false);
    await act(async()=>manga.resolve({...page,items:[{...item,type:'manga',name:'New type'}]}));
    await screen.findByText('New type');
  });

  it('revalidates a remembered partial slot before fetching more when another slot read a newer revision',async()=>{
    const old=Promise.withResolvers<CollectionPage>(),fresh=Promise.withResolvers<CollectionPage>();let games=0;
    serve(url=>{
      if(url.searchParams.get('showcase')==='true')return {...page,items:[]};
      if(url.searchParams.get('type')==='manga')return {...page,revision:'r2',items:[{...item,type:'manga',name:'New type'}]};
      if(url.searchParams.has('cursor'))return old.promise;
      return ++games===1?{...page,nextCursor:'page-2'}:fresh.promise;
    });
    render(<Collections {...props}/>);await waitFor(()=>expect(calls()).toHaveLength(2));
    pressTab('만화');await screen.findByText('New type');
    pressTab('게임');await screen.findByText(item.name);
    expect(calls().filter(([path])=>path.includes('type=game'))).toHaveLength(3);
    await act(async()=>fresh.resolve({...page,revision:'r2',items:[second]}));
    await screen.findByText(second.name);
    expect(calls().filter(([path])=>path.includes('type=game'))).toHaveLength(3);
    await act(async()=>old.resolve({...page,items:[third],nextCursor:'page-3'}));
    expect(screen.queryByText(third.name)).toBeNull();
  });

  it.each(['inactive','paused','unmounted'] as const)('aborts prefetch when %s and resumes only when enabled',async(mode)=>{
    const next=Promise.withResolvers<CollectionPage>();let requests=0;
    serve(url=>(url.searchParams.get('showcase')==='true')?{...page,items:[]}:url.searchParams.has('cursor')?(++requests===1?next.promise:{...page,items:[second]}):{...page,nextCursor:'page-2'});
    const view=render(<Collections {...props}/>);
    await waitFor(()=>expect(calls()).toHaveLength(2));
    const signal=calls()[1][1] as AbortSignal;
    if(mode==='unmounted')view.unmount();else view.rerender(<Collections {...props} active={mode!=='inactive'} paused={mode==='paused'}/>);
    expect(signal.aborted).toBe(true);
    await act(async()=>next.resolve({...page,items:[third],nextCursor:'page-3'}));
    expect(calls()).toHaveLength(2);
    if(mode!=='unmounted'){
      view.rerender(<Collections {...props}/>);await screen.findByText(second.name);
      expect(calls()).toHaveLength(3);expect(screen.queryByText(third.name)).toBeNull();
    }
  });

  it.each([['main',false],['Showcase',true]] as const)('stops %s on error, keeps received pages, and retry drains the remaining cursors without scrolling',async(_label,showcase)=>{
    let fail=true;
    serve(url=>{
      if((url.searchParams.get('showcase')==='true')!==showcase)return {...page,items:[]};
      switch(url.searchParams.get('cursor')){
        case 'page-2':return {...page,items:[second],nextCursor:'page-3'};
        case 'page-3':if(fail)throw new Error('page offline');return {...page,items:[third],nextCursor:'page-4'};
        case 'page-4':return {...page,items:[{...item,id:'fourth',name:'Fourth page'}]};
        default:return {...page,nextCursor:'page-2'};
      }
    });
    render(<Collections {...props}/>);
    if(showcase)pressShowcase(await screen.findByRole('button',{name:/^쇼케이스(?: \d+)?$/}));
    await screen.findByText(/page offline/);
    expect(screen.getByText(item.name)).toBeTruthy();expect(screen.getByText(second.name)).toBeTruthy();
    expect(calls(showcase)).toHaveLength(3);scrollToEnd(list());await act(async()=>{});
    expect(calls(showcase)).toHaveLength(3);
    fail=false;fireEvent.click(screen.getByRole('button',{name:'다시 시도'}));
    await screen.findByText('Fourth page');expect(screen.queryByText(/page offline/)).toBeNull();
    expect(calls(showcase).map(([path])=>new URL(path,'https://example.invalid').searchParams.get('cursor'))).toEqual([null,'page-2','page-3','page-3','page-4']);
    expect(screen.getAllByText(second.name)).toHaveLength(1);
  });
});

describe('visible artwork retries',()=>{
  const coverCalls=()=>mocks.native.mock.calls.filter(([op,payload])=>op==='collectionArtwork'&&payload.artworkId==='cover');
  const advance=(ms=0)=>act(async()=>{await vi.advanceTimersByTimeAsync(ms);});
  const broken=()=>screen.queryAllByText('이미지를 불러오지 못했습니다')[0]??null;
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
    mocks.api.mockImplementation(async(path:string)=>path.includes('cursor=')||!path.startsWith('/v1/collections?')||!path.includes('rating=all')?page:{...page,nextCursor:'page-2'});
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
    fireEvent.click(screen.getByRole('button',{name:'정렬'}));
    fireEvent.click(within(screen.getByRole('dialog')).getByRole('radio',{name:'최근 추가'}));
    await waitFor(()=>expect(mocks.api.mock.calls.at(-1)?.[0]).toContain('sort=recent'));
    fireEvent.click(within(screen.getByRole('dialog')).getByRole('radio',{name:'오래된순'}));
    await waitFor(()=>expect(mocks.api.mock.calls.at(-1)?.[0]).toContain('direction=asc'));
    fireEvent.click(within(screen.getByRole('dialog')).getByRole('button',{name:'닫기'}));
    expect(screen.getByRole('button',{name:'정렬'})).toBeTruthy();
    expect(screen.getByRole('button',{name:'내 별점'}).getAttribute('aria-pressed')).toBe('true');
    pressTab('만화');
    await waitFor(()=>expect(screen.getByRole('button',{name:/^내 별점/})).toBeTruthy());
    pressTab('게임');
    await waitFor(()=>expect(screen.getByRole('button',{name:'내 별점'}).getAttribute('aria-pressed')).toBe('true'));
    fireEvent.click(screen.getByRole('button',{name:'내 별점'}));
    fireEvent.click(screen.getByRole('button',{name:'초기화'}));
    await waitFor(()=>expect(mocks.api.mock.calls.at(-1)?.[0]).toContain('rating=all'));
  });
  it('preloads the Showcase count and opens its existing full content as an overlay',async()=>{
    const backRef:{current:(()=>boolean)|null}={current:null};
    render(<Collections active paused={false} backRef={backRef}/>);await screen.findByText(item.name);
    const showcaseCalls=()=>mocks.api.mock.calls.filter(([path])=>path.includes('showcase=true'));
    await waitFor(()=>expect(showcaseCalls()).toHaveLength(1));
    expect(showcaseCalls()[0][0]).not.toMatch(/rating=|sort=/);
    expect(document.querySelector('.collection-showcase-fold')).toBeNull();
    pressShowcase(screen.getByRole('button',{name:'쇼케이스'}));
    const overlay=screen.getByRole('dialog',{name:'쇼케이스'});
    expect(within(overlay).getByText('PC에서 정한 순서대로 보여 줍니다.')).toBeTruthy();
    expect(within(overlay).getByRole('button',{name:new RegExp(item.name)})).toBeTruthy();
    act(()=>{expect(backRef.current?.()).toBe(true);});
    expect(screen.queryByRole('dialog',{name:'쇼케이스'})).toBeNull();
    expect(screen.getByRole('radio',{name:'게임'})).toBeTruthy();
    expect(showcaseCalls()).toHaveLength(1);
  });
  it('updates the Showcase count per type and loads new content within its overlay',async()=>{
    const manga=Promise.withResolvers<CollectionPage>();
    mocks.api.mockImplementation(async(path:string)=>{
      if(path.includes('showcase=true'))return path.includes('type=manga')?manga.promise:{...page,totalCount:1,items:[{...item,id:'game-showcase',name:'게임 쇼케이스'}]};
      return path.includes('type=manga')?{...page,items:[{...item,id:'manga-main',name:'만화 작품'}]}:{...page,totalCount:1};
    });
    render(<Collections active paused={false} backRef={{current:null}}/>);
    await screen.findByRole('button',{name:'쇼케이스'});
    pressTab('만화');await screen.findByText('만화 작품');
    pressShowcase(screen.getByRole('button',{name:'쇼케이스'}));
    const overlay=screen.getByRole('dialog',{name:'쇼케이스'});
    expect(within(overlay).queryByRole('button',{name:'게임 쇼케이스'})).toBeNull();
    expect(within(overlay).queryByText('쇼케이스를 불러오는 중…')).toBeNull();
    await act(async()=>manga.resolve({...page,totalCount:2,items:[{...item,id:'manga-showcase',name:'만화 쇼케이스'}]}));
    expect(await within(overlay).findByRole('button',{name:/만화 쇼케이스/})).toBeTruthy();
    expect(overlay.querySelector('.mobile-overlay__title-row .numeric')?.textContent).toBe('2');
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
    mocks.api.mockRejectedValueOnce(Object.assign(new Error('요청한 정보를 찾을 수 없습니다.'),{status:404}));pull(list());await screen.findByText('컬렉션이 아직 공유되지 않았습니다');view.unmount();
  });
  it('searches after typing pauses or on Enter, and clears explicitly',async()=>{
    render(<Collections active paused={false} backRef={{current:null}}/>);await screen.findByText('밤의 도서관');
    const listPaths=()=>mocks.api.mock.calls.map(([path])=>path as string).filter(path=>path.startsWith('/v1/collections?'));
    fireEvent.change(searchBox(),{target:{value:'밤'}});
    fireEvent.submit(searchBox().closest('form')!);
    await waitFor(()=>expect(listPaths().at(-1)).toContain('q=%EB%B0%A4'));
    expect(screen.getByText('검색 결과')).toBeTruthy();
    // Shortcuts remain available while the main list is narrowed.
    expect(screen.getByRole('button',{name:'쇼케이스'})).toBeTruthy();
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
  it('hides AV from the type switch in privacy mode',async()=>{
    localStorage.setItem('lakomics.mobile.privacyMode','1');
    render(<Collections active paused={false} backRef={{current:null}}/>);
    await screen.findByText(item.name);
    const types=within(screen.getByRole('radiogroup',{name:'컬렉션 유형'}));
    expect(types.queryByRole('radio',{name:'AV'})).toBeNull();
    expect(types.getAllByRole('radio').map(radio=>radio.getAttribute('aria-label'))).toEqual(['게임','만화','영화']);
  });
  it('keeps the type switch as the list\'s first row, including while searching',async()=>{
    render(<Collections active paused={false} backRef={{current:null}}/>);await screen.findByText('밤의 도서관');
    const switcher=()=>screen.getByRole('radiogroup',{name:'컬렉션 유형'});
    expect(switcher().closest('header.top-bar')).toBeNull();
    // The section bar is the scrolling list's first row (after the zero-height refresh pill).
    const firstRow=[...list().children].find(child=>!child.matches('.pull-refresh'));
    expect(firstRow?.classList.contains('ui-section-bar--inline')).toBe(true);
    expect(firstRow?.contains(switcher())).toBe(true);
    expect(screen.getAllByRole('radiogroup',{name:'컬렉션 유형'})).toHaveLength(1);
    const listPaths=()=>mocks.api.mock.calls.map(([path])=>path as string).filter(path=>path.startsWith('/v1/collections?'));
    fireEvent.change(searchBox(),{target:{value:'밤'}});fireEvent.submit(searchBox().closest('form')!);
    await waitFor(()=>expect(listPaths().at(-1)).toContain('q=%EB%B0%A4'));
    expect(switcher().closest('header.top-bar.is-search')).toBeNull();
    // Switching type still clears the query, as it did from the list.
    pressTab('만화');
    await waitFor(()=>expect(listPaths().at(-1)).toContain('type=manga'));
    expect(listPaths().at(-1)).toContain('q=&');
    expect(searchBox().value).toBe('');
    expect(screen.getByRole('radio',{name:'만화'}).getAttribute('aria-checked')).toBe('true');
    expect(screen.getByRole('radio',{name:'게임'}).getAttribute('aria-checked')).toBe('false');
  });
  it('pulls the type switch down from the top bar once the list has scrolled past it',async()=>{
    render(<Collections active paused={false} backRef={{current:null}}/>);await screen.findByText('밤의 도서관');
    expect(screen.queryByRole('button',{name:'컬렉션 · 게임'})).toBeNull();
    list().scrollTop=400;fireEvent.scroll(list());
    const title=screen.getByRole('button',{name:'컬렉션 · 게임'});
    fireEvent.click(title);
    const shade=section().querySelector('.section-shade') as HTMLElement;
    expect(shade.classList.contains('is-open')).toBe(true);
    const listPaths=()=>mocks.api.mock.calls.map(([path])=>path as string).filter(path=>path.startsWith('/v1/collections?'));
    fireEvent.click(within(shade).getByRole('radio',{name:'만화'}));
    expect(shade.classList.contains('is-open')).toBe(true);
    await waitFor(()=>expect(listPaths().at(-1)).toContain('type=manga'));
    expect(within(list()).getByRole('radio',{name:'만화'}).getAttribute('aria-checked')).toBe('true');
  });
  it('swaps the list sideways toward the chosen type only once its page commits',async()=>{
    const animate=vi.fn(()=>({cancel(){}}));(HTMLElement.prototype as unknown as {animate:unknown}).animate=animate;
    try{
      render(<Collections active paused={false} backRef={{current:null}}/>);await screen.findByText('밤의 도서관');
      expect(animate).not.toHaveBeenCalled();
      const switcher=screen.getByRole('radiogroup',{name:'컬렉션 유형'});
      expect(switcher.classList.contains('ui-segmented')).toBe(true);
      let resolveManga!:(value:CollectionPage)=>void;
      mocks.api.mockImplementation((path:string)=>path.includes('type=manga')&&!path.includes('showcase=true')?new Promise(resolve=>{resolveManga=resolve;}):path.includes('type=av')?Promise.resolve({...page,items:[]}):Promise.resolve(page));
      pressTab('만화');await act(async()=>{});
      // Still loading: the game list stays put rather than sliding in stale.
      expect(animate).not.toHaveBeenCalled();
      await act(async()=>resolveManga({...page,items:[{...item,id:'manga-2',type:'manga',name:'새 만화'}]}));
      await screen.findByText('새 만화');
      const moves=animate.mock.calls as unknown as [Keyframe[],KeyframeAnimationOptions][];
      // The list's rows slide; its first row, the section bar, stays still.
      const moved=animate.mock.contexts as unknown as HTMLElement[];
      expect(moved.length).toBeGreaterThan(0);
      expect(moved.every(element=>element.parentElement===list()&&!element.matches('.ui-section-bar,.section-shade-rows,.pull-refresh,.mobile-scrubber'))).toBe(true);
      expect(moves.every(move=>move[0][0].transform==='translateX(16px)')).toBe(true);
      // AV lies to the right as well; back to 게임 comes in from the left.
      pressTab('AV');await screen.findByText('PC 앱이 AV 작품을 아직 보내지 않았습니다');
      expect(moves.at(-1)![0][0].transform).toBe('translateX(16px)');
      pressTab('게임');await screen.findByText('밤의 도서관');
      await waitFor(()=>expect(moves.at(-1)![0][0].transform).toBe('translateX(-16px)'));
    }finally{delete (HTMLElement.prototype as unknown as {animate?:unknown}).animate;}
  });
  it('shows the AV tab and requests the deployed AV collection type',async()=>{
    render(<Collections active paused={false} backRef={{current:null}}/>);await screen.findByText('밤의 도서관');
    expect(within(screen.getByRole('radiogroup',{name:'컬렉션 유형'})).getAllByRole('radio').map(radio=>radio.getAttribute('aria-label'))).toEqual(['게임','만화','영화','AV']);
    const before=mocks.api.mock.calls.length;
    pressTab('AV');
    expect(await screen.findByText('PC 앱이 AV 작품을 아직 보내지 않았습니다')).toBeTruthy();
    await act(async()=>{});
    expect(mocks.api.mock.calls.slice(before).some(([path])=>String(path).includes('type=av'))).toBe(true);
    expect(screen.queryByRole('searchbox')).toBeNull();
  });
  it('closes sheets on Back before leaving the work, and keeps the detail free of list controls',async()=>{
    const backRef:{current:(()=>boolean)|null}={current:null};render(<Collections active paused={false} backRef={backRef}/>);await screen.findByText('밤의 도서관');
    fireEvent.click(screen.getByRole('button',{name:/내 별점/}));
    act(()=>{expect(backRef.current?.()).toBe(true);});expect(screen.queryByRole('dialog')).toBeNull();
    fireEvent.click(screen.getByText('밤의 도서관'));
    await screen.findByRole('heading',{level:1,name:'밤의 도서관'});
    expect(screen.queryByRole('radio',{name:'게임'})).toBeNull();
    expect(screen.getByRole('button',{name:'뒤로'})).toBeTruthy();
    expect(within(screen.getByRole('button',{name:'뒤로'}).closest('header')!).getByText('컬렉션 › 게임')).toBeTruthy();
    // The shared work screen: the case on its stage, the strip of views, the information below.
    expect(screen.getByRole('article',{name:'게임 작품 화면'})).toBeTruthy();
    expect(screen.getByRole('group',{name:'케이스'})).toBeTruthy();
    expect(screen.queryByLabelText('작품 보기')).toBeNull();
    // Work information is shown, not hidden behind a disclosure.
    expect(metadataBlock().tagName).toBe('DL');
    act(()=>{expect(backRef.current?.()).toBe(true);});
    expect(screen.queryAllByRole('article',{name:'게임 작품 화면'})).toHaveLength(0);
    expect(screen.getByRole('radio',{name:'게임'})).toBeTruthy();
    act(()=>{expect(backRef.current?.()).toBe(false);});
  });
  it('opens the edition on the bookcase, requests only the shown volume\'s original, and backs out one level',async()=>{
    mocks.api.mockImplementation(async(path:string)=>path.includes('type=av')?{...page,items:[]}:path.includes('/v1/collections/')?{revision:'r1',item:mangaItem()}:{...page,items:[mangaItem()]});
    const backRef:{current:(()=>boolean)|null}={current:null};render(<Collections active paused={false} backRef={backRef}/>);
    fireEvent.click(await screen.findByText('밤의 도서관'));
    await screen.findByRole('radio',{name:'기본판'});
    expect(bookcaseLabels()).toEqual(['1권 보기','2권 보기']);
    // The book shows the first volume's full cover; no other volume's original is read.
    await waitFor(()=>expect(mocks.native).toHaveBeenCalledWith('collectionArtwork',expect.objectContaining({artworkId:'c1',variant:'original',revision:'r1'}),expect.any(AbortSignal)));
    expect(mocks.native.mock.calls.filter(([,payload])=>payload.variant==='original').map(([,payload])=>payload.artworkId)).toEqual(['c1']);
    // A double tap on the picked volume opens the cover viewer.
    await waitFor(()=>expect(screen.getByRole('button',{name:'1권 보기'}).getAttribute('aria-pressed')).toBe('true'));
    fireEvent.doubleClick(screen.getByRole('button',{name:'1권 보기'}));
    expect(within(await screen.findByRole('dialog')).getByText('2 / 3')).toBeTruthy();
    act(()=>{expect(backRef.current?.()).toBe(true);});expect(screen.queryByRole('dialog')).toBeNull();
    fireEvent.click(screen.getByRole('radio',{name:'판본 2'}));
    await finishIncomingWork();
    await waitFor(()=>expect(bookcaseLabels()).toEqual(['특별판 1권 보기']));
    act(()=>{expect(backRef.current?.()).toBe(true);});expect(screen.queryAllByRole('article',{name:'만화 작품 화면'})).toHaveLength(0);expect(mocks.api.mock.calls.every(([, ,body])=>body===undefined)).toBe(true);
    expect(screen.queryAllByRole('button',{name:/편집|삭제|가져오기|게시/})).toHaveLength(0);
  });
});

it('shows personal and provider metadata, hides manga imported descriptions, and renders TV seasons',async()=>{
 const manga={...item,type:'manga' as const,author:'작가 이름',year:2020,myScore:4.5,genres:'모험',overview:'English provider overview'};
 mocks.api.mockImplementation(async(path:string)=>path.includes('?')?{...page,items:[manga]}:{revision:'r1',item:manga});
 const view=render(<Collections active paused={false} backRef={{current:null}}/>);fireEvent.click(await screen.findByText(item.name));
 await screen.findAllByText('★ 4.5 / 5');expect(screen.queryByText('English provider overview')).toBeNull();expect(screen.getAllByText('모험').length).toBeGreaterThan(0);
 // A double tap on a spine opens the viewer as a turnable book; it can switch back to flat.
 await waitFor(()=>expect(screen.getByRole('button',{name:'1권 보기'}).getAttribute('aria-pressed')).toBe('true'));
 fireEvent.doubleClick(screen.getByRole('button',{name:'1권 보기'}));
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
 const toggle=await screen.findByRole('button',{name:'더 보기'});expect(screen.getByText('한국어 줄거리', {selector: '.collection-overview'}).classList.contains('is-clamped')).toBe(true);
 fireEvent.click(toggle);expect(screen.getByText('한국어 줄거리', {selector: '.collection-overview'}).classList.contains('is-clamped')).toBe(false);
});

describe('film details',()=>{
  const film={cast:[{name:'배우 가',character:'주인공'},{name:'배우 나',character:''}],
    releases:[{country:'US',releaseType:3,date:'2024-01-01',certification:'PG-13'},{country:'KR',releaseType:3,date:'2024-02-03',certification:'15'},{country:'JP',releaseType:4,date:'2024-05-01',certification:''}],
    related:{collectionName:'사가 컬렉션',parts:[{movieId:3,title:'속편',releaseDate:'2026-01-01'},{movieId:2,title:'전편',releaseDate:'2020-01-01'}]}};
  const open=async(detail:CollectionDetail)=>{
    mocks.api.mockImplementation(async(path:string)=>path.includes('?')?{...page,items:[detail]}:{revision:'r1',item:detail});
    render(<Collections active paused={false} backRef={{current:null}}/>);fireEvent.click(await screen.findByText(detail.name));
    await screen.findByRole('region',{name:'작품 정보'});
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
  mocks.api.mockResolvedValue({...page,totalCount:125});render(<Collections active paused={false} backRef={{current:null}}/>);await screen.findByText(item.name);expect(document.querySelector('.collection-type-label .ui-section-label__count')?.textContent?.trim()).toBe('125');
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
/** The work information names each type's own maker role (the shared fact rows), so the grid caption never has to. */
it.each([['game','개발사','아주 긴 개발사 이름'],['manga','작가','아주 긴 작가 이름'],['movie','제작사','아주 긴 제작사 이름']] as const)('names the %s maker role in the work information',async(type,role,name)=>{
  const fields=type==='game'?{developer:name}:type==='manga'?{author:name}:{productionCompany:name};
  const work={...item,...fields,type};
  mocks.api.mockImplementation(async(path:string)=>path.includes('?')?{...page,items:[work]}:{revision:'r1',item:work});
  render(<Collections active paused={false} backRef={{current:null}}/>);
  fireEvent.click(await screen.findByText(item.name));
  await screen.findByRole('region',{name:'작품 정보'});
  const row=[...metadataBlock().querySelectorAll('dl > div')].find(entry=>entry.querySelector('dt')?.textContent===role);
  expect(row?.querySelector('dd')?.textContent).toBe(name);
});

it('defaults manga to one LightCase book per work and picks before opening',async()=>{
  localStorage.removeItem('lakomics.mobile.collectionView.manga.v1');
  const manga=mangaItem(),second:CollectionDetail={...manga,id:'manga-2',name:'두 번째 만화',showcase:false};
  mocks.api.mockImplementation(async(path:string)=>path.includes('?')?{...page,items:path.includes('type=manga')?(path.includes('showcase=true')?[manga]:[manga,second]):[]}:path.endsWith('manga-2')?{revision:'r1',item:second}:{revision:'r1',item:manga});
  render(<Collections active paused={false} backRef={{current:null}}/>);pressTab('만화');
  const shelf=await screen.findByRole('group',{name:'만화 작품 목록'});
  await waitFor(()=>expect(shelf.querySelectorAll('.collection-light-case--book')).toHaveLength(2));
  expect(shelf.classList.contains('collection-list--shelf')).toBe(true);
  expect(shelf.querySelector('.manga-shelf-row')).toBeNull();
  expect(shelf.querySelector('.collection-list__group')).toBeNull();
  const tile=within(shelf).getByRole('button',{name:item.name});
  await waitFor(()=>expect(tile.querySelector('.cs-front img')?.getAttribute('src')).toBe('https://example.invalid/cover'));
  expect(tile.querySelector('.cs-spine .manga-jspine-title')?.textContent).toBe(item.name);
  fireEvent.click(tile);expect(tile.getAttribute('aria-selected')).toBe('true');
  expect(screen.queryByRole('heading',{level:1,name:item.name})).toBeNull();
  for(const empty of [list(),shelf.querySelector('.collection-list__plank')!,shelf.querySelector('.collection-list__cell')!]){
    fireEvent.click(empty);expect(tile.getAttribute('aria-selected')).toBe('false');
    expect(within(shelf).getByRole('button',{name:item.name})).toBe(tile);
    fireEvent.click(tile);expect(tile.getAttribute('aria-selected')).toBe('true');
  }
  fireEvent.scroll(list());expect(tile.getAttribute('aria-selected')).toBe('true');
  fireEvent.click(screen.getByRole('button',{name:'보기'}));
  expect(tile.getAttribute('aria-selected')).toBe('true');
  fireEvent.click(within(screen.getByRole('dialog',{name:'보기'})).getByRole('button',{name:'닫기'}));
  const secondTile=within(shelf).getByRole('button',{name:second.name});
  fireEvent.click(secondTile);expect(tile.getAttribute('aria-selected')).toBe('false');expect(secondTile.getAttribute('aria-selected')).toBe('true');
  fireEvent.click(tile);expect(tile.getAttribute('aria-selected')).toBe('true');
  fireEvent.click(tile);await screen.findByRole('heading',{level:1,name:item.name});
});

it('offers manga grid, shelf and bookcase, persists bookcase and opens its Showcase overlay',async()=>{
  localStorage.setItem('lakomics.mobile.collectionView.manga.v1',JSON.stringify({layout:'shelf',perRow:4}));
  const manga=mangaItem();
  mocks.api.mockImplementation(async(path:string)=>path.includes('?')?{...page,items:path.includes('type=manga')?[manga]:[]}:{revision:'r1',item:manga});
  render(<Collections active paused={false} backRef={{current:null}}/>);pressTab('만화');
  const shelf=await screen.findByRole('group',{name:'만화 작품 목록'});
  await waitFor(()=>expect(shelf.querySelectorAll('.collection-light-case--book')).toHaveLength(1));
  fireEvent.click(screen.getByRole('button',{name:'보기'}));
  const sheet=await screen.findByRole('dialog',{name:'보기'});
  expect(within(sheet).getAllByRole('radio')).toHaveLength(3);
  for(const name of ['격자','선반','책장'])expect(within(sheet).getByRole('radio',{name})).toBeTruthy();
  fireEvent.click(within(sheet).getByRole('radio',{name:'격자'}));
  expect(document.querySelector('.collection-grid-manga .collection-tile')).not.toBeNull();
  fireEvent.click(within(sheet).getByRole('radio',{name:'책장'}));
  expect(JSON.parse(localStorage.getItem('lakomics.mobile.collectionView.manga.v1')!)).toEqual({layout:'bookcase',perRow:4});
  expect(document.querySelector('.collection-light-case')).toBeNull();
  fireEvent.click(within(sheet).getByRole('button',{name:'닫기'}));
  await within(screen.getByRole('group',{name:'만화 작품 목록'})).findByRole('group',{name:`${item.name} 책장`});
  pressShowcase(screen.getByRole('button',{name:'쇼케이스'}));
  expect(within(screen.getByRole('dialog',{name:'쇼케이스'})).getByRole('button',{name:new RegExp(item.name)})).toBeTruthy();
});

it('ignores stored bookcase for games and offers only grid and shelf',async()=>{
  localStorage.setItem('lakomics.mobile.collectionView.game.v1',JSON.stringify({layout:'bookcase',perRow:4}));
  render(<Collections active paused={false} backRef={{current:null}}/>);
  const shelf=await screen.findByRole('group',{name:'게임 작품 목록'});
  await waitFor(()=>expect(shelf.querySelectorAll('.collection-light-case')).toHaveLength(1));
  fireEvent.click(screen.getByRole('button',{name:'보기'}));
  const sheet=await screen.findByRole('dialog',{name:'보기'});
  expect(within(sheet).getByRole('radio',{name:'선반'}).getAttribute('aria-checked')).toBe('true');
  expect(within(sheet).queryByRole('radio',{name:'책장'})).toBeNull();
});

it('stands manga on the shared bookcase rows: a tap picks a volume, a second tap opens the work there',async()=>{
  localStorage.setItem('lakomics.mobile.collectionView.manga.v1',JSON.stringify({layout:'bookcase',perRow:4}));
  const manga:CollectionDetail={...mangaItem(),showcase:false,ownedVolumes:[{editionIndex:0,count:1}]};
  mocks.api.mockImplementation(async(path:string)=>path.includes('?')?{...page,items:path.includes('type=manga')&&!path.includes('showcase=true')?[manga]:[]}:{revision:'r1',item:manga});
  render(<Collections active paused={false} backRef={{current:null}}/>);
  pressTab('만화');
  const shelf=await screen.findByRole('group',{name:`${item.name} 책장`});
  expect(within(shelf).getAllByRole('button').map(button=>button.getAttribute('aria-label'))).toEqual(['1권 보기','2권 보기']);
  const second=within(shelf).getByRole('button',{name:'2권 보기'});
  expect(second.classList.contains('manga-spine--missing')).toBe(true);
  expect(screen.getByLabelText('보유 1권').textContent).toBe('1권');
  within(shelf).getAllByRole('button').forEach((spine,index)=>{
    spine.getBoundingClientRect=()=>({left:index*32,width:30,right:index*32+30,top:16,bottom:136,height:120,x:index*32,y:16,toJSON:()=>null});
  });
  const track=shelf.querySelector<HTMLElement>('.home-shelf__track')!;
  const tapGap=()=>{
    for(const type of ['pointerdown','pointerup']){
      const event=new MouseEvent(type,{bubbles:true,clientX:31.5,clientY:8,button:0});
      Object.defineProperties(event,{pointerId:{value:1},pointerType:{value:'touch'},isPrimary:{value:true}});
      fireEvent(track,event);
    }
    fireEvent.click(track,{detail:1});
  };
  fireEvent.click(second);
  expect(second.getAttribute('aria-pressed')).toBe('true');
  expect(detailPane()?.style.display??'none').toBe('none');
  tapGap();
  expect(second.getAttribute('aria-pressed')).toBe('false');
  expect(detailPane().style.display).toBe('none');
  fireEvent.click(second);
  for(const type of ['pointerdown','pointermove','pointerup']){
    const event=new MouseEvent(type,{bubbles:true,clientX:type==='pointerdown'?20:100,clientY:20,button:0});
    Object.defineProperties(event,{pointerId:{value:1},pointerType:{value:'touch'},isPrimary:{value:true}});fireEvent(track,event);
  }
  fireEvent.click(track,{detail:1});expect(second.getAttribute('aria-pressed')).toBe('true');
  tapGap();expect(second.getAttribute('aria-pressed')).toBe('false');
  fireEvent.click(second);fireEvent.click(second);
  const bookcase=await screen.findByRole('group',{name:'권별 책장'});
  await waitFor(()=>expect(within(bookcase).getByRole('button',{name:'2권 보기'}).getAttribute('aria-pressed')).toBe('true'));
  within(bookcase).getAllByRole('button').forEach((spine,index)=>{
    spine.getBoundingClientRect=()=>({left:index*32,width:30,right:index*32+30,top:16,bottom:136,height:120,x:index*32,y:16,toJSON:()=>null});
  });
  const workTrack=bookcase.querySelector<HTMLElement>('.home-shelf__track')!;
  for(const type of ['pointerdown','pointerup']){
    const event=new MouseEvent(type,{bubbles:true,clientX:30.5,clientY:150,button:0});
    Object.defineProperties(event,{pointerId:{value:1},pointerType:{value:'touch'},isPrimary:{value:true}});
    fireEvent(workTrack,event);
  }
  await finishIncomingWork();
  const nextBookcase=screen.getByRole('group',{name:'권별 책장'});
  expect(within(nextBookcase).getByRole('button',{name:'1권 보기'}).getAttribute('aria-pressed')).toBe('true');
});

it('marks a pre-registered volume on the bookcase from its future release date',async()=>{
  const dated:CollectionDetail={...mangaItem(),volumes:[{id:'d1',volumeNumber:1,editionIndex:0,displayLabel:'1',coverArtworkId:'c1',localReleaseDate:'2024-03-05'},{id:'d2',volumeNumber:2,editionIndex:0,displayLabel:'2',coverArtworkId:'c2',localReleaseDate:'2999-01-02'}]};
  mocks.api.mockImplementation(async(path:string)=>path.includes('?')?{...page,items:[dated]}:{revision:'r1',item:dated});
  render(<Collections active paused={false} backRef={{current:null}}/>);fireEvent.click(await screen.findByText(item.name));
  await screen.findByRole('group',{name:'권별 책장'});
  expect(screen.getByRole('button',{name:'1권 보기'}).classList.contains('manga-spine--upcoming')).toBe(false);
  expect(screen.getByRole('button',{name:'2권 보기'}).classList.contains('manga-spine--upcoming')).toBe(true);
});

it('places a manga spine strip at the published cover focus, only for the current cover',async()=>{
  const focused:CollectionDetail={...mangaItem(),volumes:[{id:'f1',volumeNumber:1,editionIndex:0,displayLabel:'1',coverArtworkId:'c1',coverFocusX:0},{id:'f2',volumeNumber:2,editionIndex:0,displayLabel:'2',coverArtworkId:'c2'}]};
  expect(coverFocuses(focused.volumes)).toEqual([{volumeId:'f1',coverArtworkId:'c1',focusX:0,method:'head'}]);
  expect(coverFocuses([{...focused.volumes[0]!,coverFocusX:1.5},{...focused.volumes[1]!,coverFocusX:.4,coverArtworkId:null}])).toEqual([]);
  mocks.api.mockImplementation(async(path:string)=>path.includes('?')?{...page,items:[focused]}:{revision:'r1',item:focused});
  render(<Collections active paused={false} backRef={{current:null}}/>);fireEvent.click(await screen.findByText(item.name));
  await screen.findByRole('group',{name:'권별 책장'});
  const positions=(name:string)=>[...screen.getByRole('button',{name}).querySelectorAll('.manga-spine-strip img')].map(image=>(image as HTMLElement).style.objectPosition).filter(Boolean);
  const strip=async(name:string)=>{await waitFor(()=>expect(positions(name).length).toBeGreaterThan(0));return [...new Set(positions(name))];};
  // Focus 0 pins the strip to the cover's left edge; without a focus it stays at the shared default.
  expect(await strip('1권 보기')).toEqual(['0% 50%']);
  expect(await strip('2권 보기')).toEqual(['50% 50%']);
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
  const line=document.querySelector('.tablet-work__identity h1 + small');
  expect(line?.textContent).toBe('夜の図書館');
  view.unmount();
  for(const originalTitle of [null,'  ',' 밤의 도서관 ']){
    view=await open({...manga,originalTitle});
    expect(document.querySelector('.tablet-work__identity h1 + small')).toBeNull();
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

  it('keeps the shown type and its layout while a manga bookcase page is pending',async()=>{
    localStorage.setItem('lakomics.mobile.collectionView.manga.v1',JSON.stringify({layout:'bookcase',perRow:4}));
    const next=Promise.withResolvers<CollectionPage>();
    serve({game:page,manga:next.promise});
    render(<Collections active paused={false} backRef={{current:null}}/>);await screen.findByText(game.name);
    const previous=grid();
    pressTab('만화');await act(async()=>{});
    expect(grid()).toBe(previous);
    expect(screen.getByText(game.name)).toBeTruthy();
    expect(document.querySelector('.manga-shelf-row')).toBeNull();
    await act(async()=>next.resolve({...page,items:[manga]}));
    await within(screen.getByRole('group',{name:'만화 작품 목록'})).findByRole('group',{name:`${manga.name} 책장`});
    expect(document.querySelector('.collection-grid-game')).toBeNull();
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

describe('appended card arrival',()=>{
  const animate=vi.fn();
  beforeEach(()=>{animate.mockReset();(HTMLElement.prototype as unknown as {animate:unknown}).animate=function(this:HTMLElement,...args:unknown[]){animate(this,...args);};});
  afterEach(()=>{vi.useRealTimers();delete (HTMLElement.prototype as unknown as {animate?:unknown}).animate;});
  const card=(name:string)=>screen.getByText(name).closest('.collection-tile') as HTMLElement;
  const cardAnimations=(name:string)=>animate.mock.calls.filter(([element])=>element===card(name));
  const appendedPage={...page,nextCursor:null,items:[{...item,id:'second',name:'Second page',selectedWorkArtworkId:'cover-2'}]};
  const paged=(next:CollectionPage|Promise<CollectionPage>=appendedPage)=>mocks.api.mockImplementation(async(path:string)=>path.endsWith('/status')?{revision:'r1'}:path.includes('cursor=')?next:{...page,nextCursor:'page-2'});

  it('holds a card appended by scrolling until its cover decodes, then rises the whole card in once',async()=>{
    paged();
    render(<Collections active paused={false} backRef={{current:null}}/>);
    await screen.findByText(item.name);
    expect(card(item.name).style.opacity).not.toBe('0');
    scrollToEnd(list());await screen.findByText('Second page');
    // Cover, title and meta stay hidden together in the card's final box.
    expect(card('Second page').style.opacity).toBe('0');
    const cover=await screen.findByRole('img',{name:'Second page'});
    expect(cover.classList.contains('collection-art-arrive')).toBe(false);
    fireEvent.load(cover);await act(async()=>{});
    expect(card('Second page').style.opacity).toBe('');
    expect(cardAnimations('Second page')).toHaveLength(1);
    const [,frames]=cardAnimations('Second page')[0] as [HTMLElement,Keyframe[]];
    expect(frames[0]).toMatchObject({opacity:0,transform:'translateY(8px)'});
    // A later load or re-render never replays it, and the first page never arrived.
    fireEvent.load(cover);await act(async()=>{});
    expect(cardAnimations('Second page')).toHaveLength(1);
    expect(cardAnimations(item.name)).toHaveLength(0);
  });

  it('shows an appended card with a placeholder after the wait when its cover is slow',async()=>{
    const next=Promise.withResolvers<CollectionPage>();paged(next.promise);
    let resolveCover!:(value:unknown)=>void;
    mocks.native.mockImplementation(async(_op:string,payload:{artworkId:string})=>payload.artworkId==='cover-2'?new Promise(resolve=>{resolveCover=resolve;}):{url:'https://example.invalid/cover',expires_in:300});
    render(<Collections active paused={false} backRef={{current:null}}/>);
    await screen.findByText(item.name);
    vi.useFakeTimers();
    await act(async()=>next.resolve(appendedPage));await act(async()=>{});
    expect(card('Second page').style.opacity).toBe('0');
    act(()=>{vi.advanceTimersByTime(600);});
    expect(card('Second page').style.opacity).toBe('');
    expect(cardAnimations('Second page')).toHaveLength(1);
    expect(card('Second page').querySelector('.collection-art-placeholder')).not.toBeNull();
    // The cover that comes later fades in on its own.
    await act(async()=>{resolveCover({url:'https://example.invalid/late',expires_in:300});});
    expect(screen.getByRole('img',{name:'Second page'}).classList.contains('collection-art-arrive')).toBe(true);
    expect(cardAnimations('Second page')).toHaveLength(1);
  });
});

describe('shelf view',()=>{
  const second:CollectionDetail={...item,id:'second',name:'두 번째 게임',selectedWorkArtworkId:'cover-2'};
  beforeEach(()=>{
    localStorage.setItem('lakomics.mobile.collectionView.game.v1',JSON.stringify({layout:'shelf',perRow:4}));
    mocks.api.mockImplementation(async(path:string)=>path.includes('type=av')?{...page,items:[]}:path==='/v1/collections/second'?{revision:'r1',item:second}:path.includes('/v1/collections/')?{revision:'r1',item}:{...page,items:[item,second]});
  });
  it('stands games as light cases N per row; a tap picks, a second tap opens, swipes keep the work and edge buttons step',async()=>{
    render(<Collections active paused={false} backRef={{current:null}}/>);
    const shelf=await screen.findByRole('group',{name:'게임 작품 목록'});
    // The list group is there before its first page commits; wait for the cases.
    await waitFor(()=>expect(shelf.querySelectorAll('.collection-light-case')).toHaveLength(2));
    expect(shelf.getAttribute('data-per-row')).toBe('4');
    const tile=shelf.querySelector('[data-collection-id="manga-1"]') as HTMLElement;
    fireEvent.click(tile);
    expect(tile.getAttribute('aria-selected')).toBe('true');
    expect(screen.queryByRole('article',{name:'게임 작품 화면'})).toBeNull();
    fireEvent.click(tile);
    await screen.findByRole('heading',{level:1,name:item.name});
    // A horizontal stage swipe keeps the work; the explicit edge button steps through the list.
    const stage=document.querySelector('.tablet-work__stage') as HTMLElement;
    fireEvent.pointerDown(stage,{pointerId:1,clientX:400,clientY:200});
    fireEvent.pointerUp(stage,{pointerId:1,clientX:200,clientY:210});
    expect(screen.getByRole('heading',{level:1,name:item.name})).toBeTruthy();
    expect(screen.queryByRole('heading',{level:1,name:second.name})).toBeNull();
    expect(document.querySelector('.tablet-work__identity')?.textContent).not.toMatch(/\d+\s*\/\s*\d+/);
    fireEvent.click(screen.getByRole('button',{name:'다음 작품'}));
    await waitFor(()=>expect(document.querySelector('[data-work-pending] .k-front img')).not.toBeNull());
    expect(screen.getByRole('heading',{level:1,name:item.name})).toBeTruthy();
    await act(async()=>{document.querySelectorAll('[data-work-pending] img').forEach(image=>fireEvent.load(image));});
    expect(await screen.findByRole('heading',{level:1,name:second.name})).toBeTruthy();
    expect(document.querySelector('.tablet-work__identity')?.textContent).not.toMatch(/\d+\s*\/\s*\d+/);
  });
  it('shows the published spine on the shelf, a game case by its owned 기기, and 상태 · 기기 in 내 기록',async()=>{
    const owned:CollectionDetail={...item,platforms:'PC · PS5',ownedPlatform:'Switch 2',status:'playing',spineArtworkId:'spine-1',artworkVersions:{'spine-1':{thumbnail:'spine-digest'}}};
    mocks.api.mockImplementation(async(path:string)=>path.includes('type=av')?{...page,items:[]}:path.includes('/v1/collections/')?{revision:'r1',item:owned}:{...page,items:[owned,second]});
    mocks.native.mockImplementation(async(_op:string,payload:{artworkId?:string})=>({url:`https://example.invalid/${payload.artworkId}`,expires_in:300}));
    render(<Collections active paused={false} backRef={{current:null}}/>);
    const shelf=await screen.findByRole('group',{name:'게임 작품 목록'});
    await waitFor(()=>expect(shelf.querySelectorAll('.collection-light-case')).toHaveLength(2));
    const tile=shelf.querySelector('[data-collection-id="manga-1"]') as HTMLElement;
    // Switch 2 (owned) wins over the first listed platform (PC).
    expect((tile.querySelector('.collection-light-case') as HTMLElement).style.getPropertyValue('--plastic')).toBe('rgba(206,44,54,.9)');
    // The spine is asked for after the front, and only for the work that has one.
    await waitFor(()=>expect(tile.querySelector('.cs-spine img[src="https://example.invalid/spine-1"]')).not.toBeNull());
    const asked=mocks.native.mock.calls.filter(([op])=>op==='collectionArtwork').map(([,payload])=>payload.artworkId);
    expect(asked.indexOf('spine-1')).toBeGreaterThan(asked.indexOf('cover'));
    expect(asked.filter(id=>id==='spine-1')).toHaveLength(1);
    expect(asked).not.toContain(null);
    fireEvent.click(tile);fireEvent.click(tile);
    const record=await screen.findByRole('region',{name:'내 기록'});
    expect(within(record).getByText('상태').nextElementSibling?.textContent).toBe('하는 중');
    expect(within(record).getByText('기기').nextElementSibling?.textContent).toBe('Switch 2');
    // The booklet shares the PC's status, score and owned platform.
    expect([...document.querySelectorAll('.case-manual-form dt')].map(node=>node.textContent)).toEqual(['상태','별점','기기']);
    expect(document.querySelector('.case-manual .case-status-box.is-filled')?.getAttribute('data-status')).toBe('playing');
    expect(document.querySelector('.case-manual-form')?.textContent).toContain('Switch 2');
    expect(document.querySelector('.case-manual .case-score')).not.toBeNull();
  });
  it('leaves 상태 and 기기 out when the PC did not publish them',async()=>{
    render(<Collections active paused={false} backRef={{current:null}}/>);
    const shelf=await screen.findByRole('group',{name:'게임 작품 목록'});
    await waitFor(()=>expect(shelf.querySelectorAll('.collection-light-case')).toHaveLength(2));
    const tile=shelf.querySelector('[data-collection-id="manga-1"]') as HTMLElement;
    fireEvent.click(tile);fireEvent.click(tile);
    const record=await screen.findByRole('region',{name:'내 기록'});
    expect(within(record).queryByText('상태')).toBeNull();expect(within(record).queryByText('기기')).toBeNull();
    expect([...document.querySelectorAll('.case-manual-form dt')].map(node=>node.textContent)).toEqual(['상태','별점','기기']);
    expect(document.querySelector('.case-manual .case-status-box.is-filled')).toBeNull();
    expect(document.querySelector('.case-manual .case-writing-line')?.getAttribute('aria-label')).toBe('미입력');
  });
  it('changes 배치 and 한 줄에 N개 from the 보기 sheet and keeps them for the type',async()=>{
    render(<Collections active paused={false} backRef={{current:null}}/>);
    await screen.findByRole('group',{name:'게임 작품 목록'});
    fireEvent.click(screen.getByRole('button',{name:'보기'}));
    const sheet=await screen.findByRole('dialog',{name:'보기'});
    fireEvent.change(within(sheet).getByRole('slider',{name:'한 줄에'}),{target:{value:'6'}});
    expect(document.querySelector('[aria-label="게임 작품 목록"]')?.getAttribute('data-per-row')).toBe('6');
    fireEvent.click(within(sheet).getByRole('radio',{name:'격자'}));
    expect((document.querySelector('.collection-grid.is-counted') as HTMLElement).style.getPropertyValue('--columns')).toBe('6');
    expect(JSON.parse(localStorage.getItem('lakomics.mobile.collectionView.game.v1')!)).toEqual({layout:'grid',perRow:6});
  });
});


it('renders an empty tablet manga shelf when the detail reply has no item', async()=>{
  mocks.api.mockResolvedValue({revision:'empty-detail'});
  render(<TabletMangaShelf items={[mangaItem()]} label="만화 작품 목록" revision="empty-detail" active privacy={false} owned={()=>null} pick={null} onPick={vi.fn()} onOpen={vi.fn()}/>);
  const shelf=await screen.findByRole('group',{name:`${item.name} 책장`});
  expect(within(shelf).getByText('이 판본의 표지가 없습니다.')).toBeTruthy();
  expect(within(shelf).queryByRole('button',{name:/권 보기$/})).toBeNull();
  expect(mocks.api).toHaveBeenCalledTimes(1);
});

// The accepted tablet shortcuts replace fold previews; all content opens above a retained list.
describe('collection shortcut overlays',()=>{
  const event=(id:string)=>({id,kind:'date_set',currentValue:'2099-01-01',readAt:null});
  const game={id:'game-calendar',kind:'game',title:'게임 발매',date:'2099-01-01',precision:'exact',events:[event('g1'),event('g2')]};
  const movie={id:'movie-calendar',kind:'movie',title:'영화 발매',date:'2099-02-01',precision:'exact',events:[event('m1')]};
  const upcoming={publishedAt:'2026-10-01',entries:[game,movie],wishlist:[game,movie]};
  const serve=()=>mocks.api.mockImplementation(async(path:string)=>{
    if(path==='/v1/home/upcoming')return upcoming;
    if(path.endsWith('/status'))return {revision:'r1'};
    if(path.startsWith('/v1/collections/releases'))return {revision:1,counts:{unread:3,collections:[{collectionId:item.id,unread:3}]},items:[],nextCursor:null,hasMore:false};
    if(path.startsWith('/v1/collections?')){
      const type=new URL(path,'https://example.invalid').searchParams.get('type') as CollectionDetail['type'];
      return {...page,totalCount:path.includes('showcase=true')?12:1,items:[{...item,type}]};
    }
    return {revision:'r1',item};
  });
  const shortcuts=()=>screen.getByRole('group',{name:'컬렉션 바로가기'});
  it.each([['게임','발매 캘린더 2'],['영화','발매 캘린더 1'],['만화','신간 3'],['AV',null]] as const)('shows the %s shortcuts, counts and right-group order',async(type,other)=>{
    serve();render(<Collections active paused={false} backRef={{current:null}}/>);
    pressTab(type);
    await within(shortcuts()).findByRole('button',{name:'쇼케이스'});
    const buttons=within(shortcuts()).getAllByRole('button');expect(buttons).toHaveLength(other?2:1);
    expect(shortcuts().closest('.ui-section-bar__trailing')).not.toBeNull();
    expect(document.querySelector('.section-shade-extra,.section-shade-rows--inline')).toBeNull();
    expect(shortcuts().nextElementSibling?.className).toBe('collection-shortcuts__divider');
    expect(Array.from(shortcuts().parentElement!.children).slice(2).map(button=>button.getAttribute('aria-label'))).toEqual(['정렬','내 별점','보기']);
    expect(buttons[0].querySelector('.collection-shortcuts__count')).toBeNull();
    if(other){const shortcut=await within(shortcuts()).findByRole('button',{name:other});expect(shortcut.querySelector('.is-new')?.textContent).toBe(other.endsWith('3')?'3':other.endsWith('2')?'2':'1');}
    expect(buttons[0].getAttribute('aria-pressed')).toBe('false');
    for(const button of buttons.slice(1)){expect(button.getAttribute('aria-pressed')).toBeNull();expect(button.getAttribute('data-segmented-active')).toBeNull();expect(button.querySelector('svg')).toBeTruthy();}
    expect(document.querySelector('.collection-showcase-fold,.collection-news-section')).toBeNull();
    // Counts do not fetch the retired manga news preview.
    expect(mocks.api.mock.calls.some(([path])=>path.startsWith('/v1/collections/releases?limit=100'))).toBe(false);
  });
  it('carries shortcuts and sheets in the same shade row, retaining the list', async()=>{
    serve();render(<Collections active paused={false} backRef={{current:null}}/>);
    await within(shortcuts()).findByRole('button',{name:'쇼케이스'});
    const scroller=list(),cards=scroller.querySelector('.collection-grid');
    scroller.scrollTop=440;fireEvent.scroll(scroller);
    fireEvent.click(screen.getByRole('button',{name:'컬렉션 · 게임'}));
    const shade=document.querySelector('.section-shade.is-open') as HTMLElement;
    const right=shade.querySelector('.ui-section-bar__trailing') as HTMLElement;
    expect(within(right).getByRole('button',{name:'쇼케이스'})).toBeTruthy();
    expect(within(right).getByRole('button',{name:'발매 캘린더 2'})).toBeTruthy();
    fireEvent.click(within(right).getByRole('button',{name:'보기'}));
    expect(screen.getByRole('dialog',{name:'보기'})).toBeTruthy();
    expect(scroller.querySelector('.collection-grid')).toBe(cards);
    expect(scroller.scrollTop).toBe(440);
  });
  it.each(['게임','영화','만화'])('hides the zero news count for %s and retains the zero Showcase count',async(type)=>{
    mocks.api.mockImplementation(async(path:string)=>path==='/v1/home/upcoming'?{entries:[],wishlist:[]}:path.startsWith('/v1/collections/releases')?{counts:{unread:0,collections:[]}}:{...page,totalCount:0,items:[]});
    render(<Collections active paused={false} backRef={{current:null}}/>);pressTab(type);
    await within(shortcuts()).findByRole('button',{name:'쇼케이스'});
    const other=within(shortcuts()).getByRole('button',{name:type==='만화'?'신간':'발매 캘린더'});
    expect(other.querySelector('.collection-shortcuts__count')).toBeNull();
  });
  it.each([['게임','쇼케이스','쇼케이스'],['게임','발매 캘린더','발매 캘린더'],['영화','발매 캘린더','발매 캘린더'],['만화','신간','신간']] as const)('opens %s %s over the retained list and Back closes it before leaving',async(type,shortcut,title)=>{
    serve();const backRef:{current:(()=>boolean)|null}={current:null},home=vi.fn();
    render(<Collections active paused={false} backRef={backRef} onReturnHome={home}/>);pressTab(type);await within(shortcuts()).findByRole('button',{name:'쇼케이스'});
    const scroller=list(),cards=scroller.querySelector('.collection-grid');scroller.scrollTop=440;fireEvent.scroll(scroller);
    fireEvent.click(within(shortcuts()).getByRole('button',{name:new RegExp(`^${shortcut}`)}));
    const overlay=screen.getByRole('dialog',{name:title});
    if(title==='쇼케이스')expect(scroller.querySelector('.collection-shortcuts [aria-pressed]')?.getAttribute('aria-pressed')).toBe('true');
    expect(scroller.style.display).toBe('');expect(scroller.scrollTop).toBe(440);expect(scroller.querySelector('.collection-grid')).toBe(cards);
    expect(scroller.hasAttribute('inert')).toBe(true);
    if(title==='발매 캘린더'){
      await within(overlay).findByText(type==='게임'?'게임 발매':'영화 발매');
      expect(within(overlay).queryByText(type==='게임'?'영화 발매':'게임 발매')).toBeNull();
      expect(document.querySelector('.release-calendar-layer')).toBeNull();
      expect(within(overlay).queryByRole('button',{name:'홈으로'})).toBeNull();
    }
    if(title==='신간')expect(within(overlay).getByRole('radiogroup',{name:'신간 지역'})).toBeTruthy();
    act(()=>{expect(backRef.current?.()).toBe(true);});expect(screen.queryByRole('dialog',{name:title})).toBeNull();
    expect(list()).toBe(scroller);expect(scroller.scrollTop).toBe(440);expect(scroller.querySelector('.collection-grid')).toBe(cards);
    if(title==='쇼케이스')expect(scroller.querySelector('.collection-shortcuts [aria-pressed]')?.getAttribute('aria-pressed')).toBe('false');
    if(title!=='신간')expect(home).not.toHaveBeenCalled();
    act(()=>{expect(backRef.current?.()).toBe(false);});
  });
  it('opens from the pulled shade, then restores the list and its two-row bar',async()=>{
    serve();render(<Collections active paused={false} backRef={{current:null}}/>);await within(shortcuts()).findByRole('button',{name:'쇼케이스'});
    list().scrollTop=380;fireEvent.scroll(list());fireEvent.click(screen.getByRole('button',{name:'컬렉션 · 게임'}));
    const shade=document.querySelector('.section-shade') as HTMLElement;
    expect(within(shade).getByRole('radiogroup',{name:'컬렉션 유형'})).toBeTruthy();
    pressShowcase(within(shade).getByRole('button',{name:'쇼케이스'}));
    expect(screen.getByRole('dialog',{name:'쇼케이스'})).toBeTruthy();
    fireEvent.click(screen.getByRole('button',{name:'쇼케이스 닫기'}));expect(list().scrollTop).toBe(380);
    expect(document.querySelector('.section-shade.is-open')).toBeNull();
  });
  it('keeps the Showcase scroll and artwork when a work stacks above it, and Back returns there first',async()=>{
    const shown={...item,id:'showcase-work',name:'전시 작품'};
    mocks.api.mockImplementation(async(path:string)=>path.endsWith('/status')?{revision:'r1'}:path==='/v1/home/upcoming'?{entries:[],wishlist:[]}:path.includes('showcase=true')?{...page,totalCount:1,items:[shown]}:path.startsWith('/v1/collections?')?page:{revision:'r1',item:shown});
    const backRef:{current:(()=>boolean)|null}={current:null},home=vi.fn();
    render(<Collections active paused={false} backRef={backRef} onReturnHome={home}/>);await screen.findByText(item.name);
    list().scrollTop=350;fireEvent.scroll(list());pressShowcase(screen.getByRole('button',{name:'쇼케이스'}));
    const overlay=screen.getByRole('dialog',{name:'쇼케이스'}),scroll=overlay.querySelector('.collection-scroll') as HTMLElement;
    const image=await within(overlay).findByRole('img',{name:shown.name});scroll.scrollTop=240;fireEvent.scroll(scroll);
    const reads=mocks.api.mock.calls.filter(([path])=>path.includes('showcase=true')).length;
    fireEvent.click(within(overlay).getByRole('button',{name:new RegExp(shown.name)}));await screen.findByRole('heading',{level:1,name:shown.name});
    expect(screen.queryByRole('dialog',{name:'쇼케이스'})).toBeNull();
    act(()=>{expect(backRef.current?.()).toBe(true);});
    expect(screen.getByRole('dialog',{name:'쇼케이스'})).toBe(overlay);expect(scroll.scrollTop).toBe(240);
    expect(within(overlay).getByRole('img',{name:shown.name})).toBe(image);expect(home).not.toHaveBeenCalled();
    expect(mocks.api.mock.calls.filter(([path])=>path.includes('showcase=true'))).toHaveLength(reads);
    act(()=>{expect(backRef.current?.()).toBe(true);});expect(list().scrollTop).toBe(350);expect(home).not.toHaveBeenCalled();
  });
  it.each([['게임','game'],['만화','manga'],['영화','movie'],['AV','av']] as const)('uses the %s shelf and per-row choice in Showcase, and returns from the work',async(label,type)=>{
    localStorage.setItem(`lakomics.mobile.collectionView.${type}.v1`,JSON.stringify({layout:'shelf',perRow:6}));
    const shown={...item,type};
    mocks.api.mockImplementation(async(path:string)=>path.endsWith('/status')?{revision:'r1'}:path==='/v1/home/upcoming'?{entries:[],wishlist:[]}:path.startsWith('/v1/collections?')?{...page,items:Array.from({length:7},(_,i)=>({...shown,id:i===0?item.id:`extra-${i}`,name:i===0?item.name:`작품 ${i}`}))}:{revision:'r1',item:shown});
    const backRef:{current:(()=>boolean)|null}={current:null};
    render(<Collections active paused={false} backRef={backRef}/>);pressTab(label);
    await screen.findByRole('group',{name:`${label} 작품 목록`});
    pressShowcase(await screen.findByRole('button',{name:'쇼케이스'}));
    const overlay=screen.getByRole('dialog',{name:'쇼케이스'}),scroll=overlay.querySelector('.collection-scroll') as HTMLElement;
    const shelf=within(overlay).getByRole('group',{name:`${label} 쇼케이스 작품 목록`});
    expect(shelf.getAttribute('data-per-row')).toBe('6');
    expect(shelf.classList.contains('collection-list--shelf')).toBe(true);
    expect(shelf.querySelectorAll('.collection-light-case')).toHaveLength(7);
    expect(shelf.querySelectorAll('.collection-list__plank')).toHaveLength(2);
    expect(shelf.querySelector('.collection-list--showcase')).toBeNull();
    const tile=within(shelf).getByRole('button',{name:item.name});
    await waitFor(()=>expect(mocks.native.mock.calls.some(([op,payload])=>op==='collectionArtwork'&&payload.artworkId==='cover')).toBe(true));
    scroll.scrollTop=180;fireEvent.scroll(scroll);
    fireEvent.click(tile);expect(tile.getAttribute('aria-selected')).toBe('true');
    expect(screen.getByRole('dialog',{name:'쇼케이스'})).toBe(overlay);
    fireEvent.click(tile);await screen.findByRole('heading',{level:1,name:item.name});
    act(()=>{expect(backRef.current?.()).toBe(true);});
    expect(screen.getByRole('dialog',{name:'쇼케이스'})).toBe(overlay);
    expect(scroll.scrollTop).toBe(180);expect(within(shelf).getByRole('button',{name:item.name})).toBe(tile);
  });
  it('uses the selected grid column count in Showcase',async()=>{
    localStorage.setItem('lakomics.mobile.collectionView.game.v1',JSON.stringify({layout:'grid',perRow:6}));
    serve();render(<Collections active paused={false} backRef={{current:null}}/>);
    pressShowcase(await screen.findByRole('button',{name:'쇼케이스'}));
    const overlay=screen.getByRole('dialog',{name:'쇼케이스'});
    expect((overlay.querySelector('.collection-grid.is-counted') as HTMLElement).style.getPropertyValue('--columns')).toBe('6');
    expect(overlay.querySelector('.collection-light-case')).toBeNull();
  });
  it('uses manga bookcase rows in Showcase and returns after opening a volume',async()=>{
    localStorage.setItem('lakomics.mobile.collectionView.manga.v1',JSON.stringify({layout:'bookcase',perRow:4}));
    mocks.api.mockImplementation(async(path:string)=>path.endsWith('/status')?{revision:'r1'}:path==='/v1/home/upcoming'?{entries:[],wishlist:[]}:path.startsWith('/v1/collections?')?{...page,items:[mangaItem()]}:{revision:'r1',item:mangaItem()});
    const backRef:{current:(()=>boolean)|null}={current:null};
    render(<Collections active paused={false} backRef={backRef}/>);pressTab('만화');
    pressShowcase(await screen.findByRole('button',{name:'쇼케이스'}));
    const overlay=screen.getByRole('dialog',{name:'쇼케이스'});
    const shelf=within(overlay).getByRole('group',{name:'만화 쇼케이스 작품 목록'});
    expect(shelf.classList.contains('manga-shelf-list')).toBe(true);
    const row=await within(shelf).findByRole('group',{name:`${item.name} 책장`});
    const volume=await within(row).findByRole('button',{name:/1.*권 보기$/});
    fireEvent.click(volume);fireEvent.click(volume);
    await screen.findByRole('heading',{level:1,name:item.name});
    act(()=>{expect(backRef.current?.()).toBe(true);});
    expect(screen.getByRole('dialog',{name:'쇼케이스'})).toBe(overlay);
    expect(within(shelf).getByRole('group',{name:`${item.name} 책장`})).toBe(row);
  });
  it('closes the overlay before a retained top-bar search can consume Back',async()=>{
    serve();const backRef:{current:(()=>boolean)|null}={current:null};
    render(<Collections active paused={false} backRef={backRef}/>);await within(shortcuts()).findByRole('button',{name:'쇼케이스'});
    fireEvent.change(searchBox(),{target:{value:'밤'}});fireEvent.submit(searchBox().closest('form')!);
    pressShowcase(screen.getByRole('button',{name:'쇼케이스'}));expect(screen.queryByRole('searchbox')).toBeNull();
    act(()=>{expect(backRef.current?.()).toBe(true);});expect(screen.getByRole('searchbox').getAttribute('value')).toBe('밤');
  });
});


it('retains the painted Showcase while its pull-to-refresh reads a replacement',async()=>{
  const replacement=Promise.withResolvers<CollectionPage>();let reads=0;
  mocks.api.mockImplementation(async(path:string)=>path.endsWith('/status')?{revision:'r1'}:path==='/v1/home/upcoming'?{entries:[],wishlist:[]}:path.includes('showcase=true')?(++reads===1?page:replacement.promise):page);
  render(<Collections active paused={false} backRef={{current:null}}/>);await screen.findByText(item.name);
  pressShowcase(screen.getByRole('button',{name:'쇼케이스'}));
  const overlay=screen.getByRole('dialog',{name:'쇼케이스'}),host=overlay.querySelector('.collection-scroll') as HTMLElement;
  const tile=within(overlay).getByRole('button',{name:new RegExp(item.name)});
  pull(host);expect(reads).toBe(2);
  expect(within(overlay).getByRole('button',{name:new RegExp(item.name)})).toBe(tile);
  await act(async()=>replacement.resolve({...page,revision:'r2'}));
  expect(within(overlay).getByRole('button',{name:new RegExp(item.name)})).toBe(tile);
});


it('blocks spine double-tap during privacy and closes an already open original cover viewer',async()=>{
 mocks.api.mockImplementation(async(path:string)=>path.includes('type=av')?{...page,items:[]}:path.includes('/v1/collections/')?{revision:'r1',item:mangaItem()}:{...page,items:[mangaItem()]});
 render(<Collections active paused={false} backRef={{current:null}}/>);
 fireEvent.click(await screen.findByText(item.name));
 const spine=await screen.findByRole('button',{name:'1권 보기'});
 await waitFor(()=>expect(spine.getAttribute('aria-pressed')).toBe('true'));
 fireEvent.doubleClick(spine);await screen.findByRole('dialog');
 act(()=>{localStorage.setItem('lakomics.mobile.privacyMode','1');window.dispatchEvent(new Event('lakomics-privacy-mode'));});
 expect(screen.queryByRole('dialog')).toBeNull();expect(document.querySelector('img[src]')).toBeNull();
 const requests=mocks.native.mock.calls.length;
 fireEvent.doubleClick(screen.getByRole('button',{name:'1권 보기'}));
 expect(screen.queryByRole('dialog')).toBeNull();expect(mocks.native.mock.calls.length).toBe(requests);
});

let stopWorkImages: (() => void) | undefined;
beforeEach(() => { stopWorkImages = workImageLoads(); });
afterEach(() => { stopWorkImages?.(); });
