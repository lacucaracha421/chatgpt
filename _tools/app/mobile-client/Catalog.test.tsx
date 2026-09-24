import {afterEach,beforeEach,describe,it,expect,vi} from 'vitest';
import {act,cleanup,fireEvent,render,screen,waitFor} from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import {Catalog} from './Catalog';
import {suggestionQuery,type CatalogItem,type CatalogPage} from './catalogModel';
const mocks=vi.hoisted(()=>({api:vi.fn(),native:vi.fn(),decode:vi.fn()}));
vi.mock('./media',()=>({decodeImage:mocks.decode}));
vi.mock('./transport',()=>({api:mocks.api,native:mocks.native,errorText:(e:Error)=>e.message}));
const item:CatalogItem={provider:'kHentai',providerWorkId:'42',groupId:'group',title:'밤의 도서관',titleJpn:null,thumbnailUrl:null,artists:['작가'],series:[],fileCount:40,views:1200,posted:1000,bookmarked:true,versionCount:2,hasBookmarkedVersion:true};
const page:CatalogPage={ready:true,publicationRevision:'p1',publishedAt:null,items:[item],nextCursor:null,context:'context',countToken:'count',totalCount:null,countStatus:'pending'};
/** A `/status` reply that advertises the device display-preference contract. */
const capableStatus={publicationRevision:'p1',capabilities:{bookmarkWrite:false,displayPreferencesVersion:1}};
const legacyStatus={publicationRevision:'p1',capabilities:{bookmarkWrite:false}};
const searchParams=(path:string)=>new URL(path,'https://example.invalid').searchParams;
const lastSearch=()=>mocks.api.mock.calls.filter(([path])=>(path as string).includes('/search?')).at(-1)![0] as string;
beforeEach(()=>{Object.defineProperty(window,'innerWidth',{configurable:true,value:800});Object.defineProperty(window,'innerHeight',{configurable:true,value:1280});mocks.decode.mockReset();mocks.decode.mockResolvedValue({naturalWidth:600,naturalHeight:900});localStorage.clear();mocks.api.mockReset();mocks.native.mockReset();mocks.native.mockResolvedValue({url:'data:image/gif;base64,R0lGODlhAQABAAAAACw=',expires_in:240});mocks.api.mockImplementation(async(path:string)=>{
  if(path.includes('/count?'))return {publicationRevision:'p1',totalCount:1};
  if(path.includes('/reader?'))return {publicationRevision:'p1',provider:'kHentai',providerWorkId:'42',manifestExpiresAt:1800000000,pages:[0,1,2,3,4].map(index=>({index,url:`https://a.siam-cdn.net/${index}.webp?expires=1800000000`,name:`${index}.webp`,width:1200,height:1800,expiresAt:1800000000}))};
  if(path.includes('/status'))return capableStatus;
  if(path.includes('/works/'))return {publicationRevision:'p1',item:{...item,tagGroups:[{namespace:'artist',values:['작가']}],uploader:null,category:1,updated:null,fileSize:null,rating:null}};
  if(path.includes('/editions?'))return {publicationRevision:'p1',groupId:'group',selectedProviderWorkId:null,items:[item],nextCursor:null,totalCount:1};
  return page;
});});
const CHOICES:Record<string,string>={korean:'한국어',japanese:'일본어',all:'전체 언어',latest:'최신순',views:'조회순',hotDay:'오늘 인기',hotWeek:'이번 주 인기',hotMonth:'이번 달 인기'};
/** Open a chip's sheet and pick one option, as a user does. */
function choose(group:'카탈로그 언어'|'카탈로그 정렬',value:string){fireEvent.click(screen.getByRole('button',{name:new RegExp(`^${group}`)}));fireEvent.click(screen.getByRole('radio',{name:CHOICES[value]}));}
afterEach(cleanup);
describe('catalog cover retention',()=>{
  const preview='https://app.lakomics.local/media-cache/cover';
  const props={active:true,paused:false,backRef:{current:null}};
  const image=()=>document.querySelector<HTMLImageElement>('.catalog-grid .catalog-cover-image img');
  const requests=()=>mocks.native.mock.calls.filter(([op,payload])=>op==='catalogImage'&&payload.kind==='cover');
  let work:CatalogItem,revision:string,observers:((visible:boolean)=>void)[];
  beforeEach(()=>{
    work={...item,thumbnailUrl:'https://example.invalid/cover.jpg'};revision='p1';observers=[];
    vi.stubGlobal('IntersectionObserver',class {
      constructor(callback:(entries:{isIntersecting:boolean}[])=>void){observers.push(visible=>callback([{isIntersecting:visible}]));}
      observe(){} disconnect(){}
    });
    mocks.native.mockResolvedValue({url:preview});
    mocks.api.mockImplementation(async(path:string)=>path.includes('/status')?{...capableStatus,publicationRevision:revision}:{...page,items:[work],publicationRevision:revision,countToken:null,countStatus:'ready',totalCount:1});
  });
  afterEach(()=>vi.unstubAllGlobals());
  async function open(){
    const view=render(<Catalog {...props}/>);await screen.findByText(item.title);
    act(()=>observers.forEach(notify=>notify(true)));return view;
  }
  async function loaded(){await waitFor(()=>expect(image()).not.toBeNull());fireEvent.load(image()!);return image()!;}

  it.each(['inactive','paused','invisible'] as const)('reuses the successful cover and image DOM after %s return',async(mode)=>{
    const view=await open(),original=await loaded();expect(requests()).toHaveLength(1);
    if(mode==='invisible'){act(()=>observers.forEach(notify=>notify(false)));act(()=>observers.forEach(notify=>notify(true)));}
    else {view.rerender(<Catalog {...props} active={mode!=='inactive'} paused={mode==='paused'}/>);view.rerender(<Catalog {...props}/>);}
    await act(async()=>{});
    expect(requests()).toHaveLength(1);expect(image()).toBe(original);expect(image()?.src).toBe(preview);
  });

  it('retries a failed ticket and an image error on return, then reuses the recovered image',async()=>{
    mocks.native.mockRejectedValueOnce(new Error('offline'));
    const view=await open();await act(async()=>{});expect(image()).toBeNull();expect(requests()).toHaveLength(1);
    view.rerender(<Catalog {...props} active={false}/>);view.rerender(<Catalog {...props}/>);
    await loaded();expect(requests()).toHaveLength(2);
    fireEvent.error(image()!);expect(image()).toBeNull();
    act(()=>observers.forEach(notify=>notify(false)));act(()=>observers.forEach(notify=>notify(true)));
    const recovered=await loaded();expect(requests()).toHaveLength(3);
    view.rerender(<Catalog {...props} paused/>);view.rerender(<Catalog {...props}/>);await act(async()=>{});
    expect(requests()).toHaveLength(3);expect(image()).toBe(recovered);
  });

  it('retries an aborted ticket and ignores its late reply even if native ignores cancellation',async()=>{
    const old=Promise.withResolvers<{url:string}>();mocks.native.mockReturnValueOnce(old.promise);
    const view=await open();await waitFor(()=>expect(requests()).toHaveLength(1));
    const signal=requests()[0][2] as AbortSignal;
    view.rerender(<Catalog {...props} active={false}/>);expect(signal.aborted).toBe(true);
    view.rerender(<Catalog {...props}/>);const current=await loaded();expect(requests()).toHaveLength(2);
    await act(async()=>old.resolve({url:`${preview}-stale`}));
    expect(image()).toBe(current);expect(image()?.src).toBe(preview);
    view.rerender(<Catalog {...props} paused/>);view.rerender(<Catalog {...props}/>);await act(async()=>{});
    expect(requests()).toHaveLength(2);
  });

  it.each(['work','thumbnail','revision'] as const)('refreshes a changed %s on the same mounted card without presenting the old source',async(field)=>{
    await open();await loaded();const card=document.querySelector('.catalog-card');
    const next=Promise.withResolvers<{url:string}>();mocks.native.mockReturnValueOnce(next.promise);
    if(field==='work')work={...work,providerWorkId:'77'};
    if(field==='thumbnail')work={...work,thumbnailUrl:'https://example.invalid/new.jpg'};
    if(field==='revision')revision='p2';
    choose('카탈로그 언어','japanese');
    await waitFor(()=>expect(requests()).toHaveLength(2));expect(document.querySelector('.catalog-card')).toBe(card);
    expect(requests()[1][1]).toMatchObject({workId:work.providerWorkId,url:work.thumbnailUrl,revision});
    expect(image()).toBeNull();
    await act(async()=>next.resolve({url:`${preview}-new`}));expect(image()?.src).toBe(`${preview}-new`);
  });

  it('ignores an old source reply after the same mounted card changes source',async()=>{
    const old=Promise.withResolvers<{url:string}>();mocks.native.mockReturnValueOnce(old.promise);
    await open();await waitFor(()=>expect(requests()).toHaveLength(1));
    const signal=requests()[0][2] as AbortSignal;
    work={...work,thumbnailUrl:'https://example.invalid/new.jpg'};
    choose('카탈로그 언어','japanese');
    const current=await loaded();expect(signal.aborted).toBe(true);expect(requests()).toHaveLength(2);
    await act(async()=>old.resolve({url:`${preview}-stale`}));expect(image()).toBe(current);expect(image()?.src).toBe(preview);
  });

  it('stops displaying a removed thumbnail without issuing a media request',async()=>{
    await open();await loaded();work={...work,thumbnailUrl:null};
    choose('카탈로그 언어','japanese');
    await act(async()=>{});expect(image()).toBeNull();expect(requests()).toHaveLength(1);
  });
});

describe('mobile catalog reads',()=>{
  it('ignores a reader response after the catalog becomes inactive even if transport ignores abort',async()=>{
    const original=mocks.api.getMockImplementation()!;
    const deferred=Promise.withResolvers<unknown>();
    let reads=0;
    mocks.api.mockImplementation((path,...args)=>{
      if(!path.includes('/reader?'))return original(path,...args);
      if(++reads===1)return deferred.promise;
      return original(path,...args);
    });
    const backRef={current:null};
    const {rerender}=render(<Catalog active paused={false} backRef={backRef}/>);
    fireEvent.click(await screen.findByText('밤의 도서관'));
    // The settled detail page has already started the one background manifest request.
    fireEvent.click(await screen.findByRole('button',{name:'읽기'}));
    await waitFor(()=>expect(reads).toBe(1));
    rerender(<Catalog active={false} paused={false} backRef={backRef}/>);
    await act(async()=>deferred.resolve({publicationRevision:'p1',provider:'kHentai',providerWorkId:'42',manifestExpiresAt:1800000000,pages:[]}));
    rerender(<Catalog active paused={false} backRef={backRef}/>);
    expect(screen.queryByRole('button',{name:'읽기 닫기'})).toBeNull();
    // The abandoned response was never cached, so the next read asks again and shows real pages.
    fireEvent.click(await screen.findByRole('button',{name:'읽기'}));
    await screen.findByRole('img',{name:'1페이지'});
    expect(mocks.api.mock.calls.filter(([path])=>path.includes('/reader?'))).toHaveLength(2);
  });
  it('never caches a prefetched manifest that belongs to another work',async()=>{
    const original=mocks.api.getMockImplementation()!;
    const deferred=Promise.withResolvers<unknown>();
    let reads=0;
    mocks.api.mockImplementation((path,...args)=>{
      if(!path.includes('/reader?'))return original(path,...args);
      return ++reads===1?deferred.promise:original(path,...args);
    });
    render(<Catalog active paused={false} backRef={{current:null}}/>);
    fireEvent.click(await screen.findByText('밤의 도서관'));await screen.findByText('40페이지 · 조회 1,200');
    await waitFor(()=>expect(reads).toBe(1));
    // The background response names a different work, so it must not become the cached manifest.
    await act(async()=>deferred.resolve({publicationRevision:'p1',provider:'kHentai',providerWorkId:'77',manifestExpiresAt:1800000000,pages:[]}));
    fireEvent.click(screen.getByRole('button',{name:'읽기'}));
    await screen.findByRole('img',{name:'1페이지'});
    expect(reads).toBe(2);
  });
  it('prefetches the reader manifest once and reuses it for the explicit read',async()=>{
    render(<Catalog active paused={false} backRef={{current:null}}/>);
    fireEvent.click(await screen.findByText('밤의 도서관'));await screen.findByText('40페이지 · 조회 1,200');
    await waitFor(()=>expect(mocks.api.mock.calls.filter(([path])=>path.includes('/reader?'))).toHaveLength(1));
    fireEvent.click(screen.getByRole('button',{name:'읽기'}));
    await screen.findByRole('button',{name:'읽기 닫기'});
    expect(mocks.api.mock.calls.filter(([path])=>path.includes('/reader?'))).toHaveLength(1);
    // Manifest-only: the reader still asks the native layer for the pages it displays.
    await screen.findByRole('img',{name:'1페이지'});
    expect(mocks.native.mock.calls.filter(([op])=>op==='catalogImage').length).toBeLessThanOrEqual(3);
  });
  it('delivers a usable page while count is pending and keeps it on count failure',async()=>{
    let reject!:(e:Error)=>void;mocks.api.mockImplementation(path=>path.includes('/count?')?new Promise((_,r)=>{reject=r;}):Promise.resolve(page));
    render(<Catalog active paused={false} backRef={{current:null}}/>);await screen.findByText('밤의 도서관');expect(screen.queryByText('개수 확인 중')).toBeNull();
    await waitFor(()=>expect(typeof reject).toBe('function'));await act(async()=>reject(new Error('count unavailable')));expect(screen.getByText('밤의 도서관')).toBeTruthy();expect(screen.queryByText('0개')).toBeNull();await screen.findByText('개수를 확인하지 못했습니다.');
  });
  it('ignores an old query and never sends a bookmark write',async()=>{
    let resolve!:(p:CatalogPage)=>void;
    // One read is held in flight and then superseded by a later language change,
    // so its late response must not be able to replace the current list.
    const original=mocks.api.getMockImplementation()!;let searches=0;
    mocks.api.mockImplementation((path,...args)=>{
      if(!(path as string).includes('/search?'))return original(path,...args);
      if(searches++===1)return new Promise<CatalogPage>(r=>{resolve=r;});
      return original(path,...args);
    });
    render(<Catalog active paused={false} backRef={{current:null}}/>);await screen.findByText('밤의 도서관');
    choose('카탈로그 언어','japanese');await waitFor(()=>expect(searches).toBe(2));
    choose('카탈로그 언어','all');await screen.findByText('밤의 도서관');
    await act(async()=>resolve({...page,items:[{...item,title:'오래된 결과'}]}));expect(screen.queryByText('오래된 결과')).toBeNull();
    fireEvent.click(screen.getByRole('button',{name:'북마크',exact:true}));await waitFor(()=>expect(mocks.api.mock.calls.some(([path])=>path.includes('scope=bookmarked'))).toBe(true));
    expect(mocks.api.mock.calls.every(([, ,body])=>body===undefined)).toBe(true);
  });
  it('opens detail and editions, keeps list state, and backs out one level',async()=>{
    const backRef:{current:(()=>boolean)|null}={current:null};render(<Catalog active paused={false} backRef={backRef}/>);
    fireEvent.click(await screen.findByText('밤의 도서관'));await screen.findByText('40페이지 · 조회 1,200');
    await screen.findByRole('region',{name:'카탈로그 판본'});expect(mocks.api.mock.calls.some(([p])=>p.includes('/works/kHentai/42?context=context'))).toBe(true);
    act(()=>{expect(backRef.current?.()).toBe(true);});expect(screen.queryByText('40페이지 · 조회 1,200')).toBeNull();expect(screen.getByText('밤의 도서관')).toBeTruthy();
    expect(screen.queryByRole('button',{name:/편집|삭제|게시|다운로드/})).toBeNull();
  });
  it('keeps the current page until the next decoded page is ready and reuses its preloaded element',async()=>{
    const pending=new Map<string,()=>void>();
    mocks.native.mockImplementation(async(_op,payload)=>({url:`https://app.lakomics.local/media-cache/page-${payload.index}`,expires_in:240}));
    mocks.decode.mockImplementation((url:string)=>url.endsWith('-0')?Promise.resolve({naturalWidth:600,naturalHeight:1200}):new Promise(resolve=>pending.set(url,()=>resolve({naturalWidth:600,naturalHeight:1200}))));
    render(<Catalog active paused={false} backRef={{current:null}}/>);fireEvent.click(await screen.findByText('밤의 도서관'));fireEvent.click(await screen.findByRole('button',{name:'읽기'}));
    await screen.findByRole('img',{name:'1페이지'});await waitFor(()=>expect(pending.size).toBeGreaterThan(0));
    const preloaded=document.querySelector('[data-page="1"]');
    expect((document.querySelector('.catalog-reader-leaf') as HTMLElement).style.flexBasis).toBe('100%');
    fireEvent.click(screen.getByRole('button',{name:'다음 페이지'}));expect(screen.getByRole('img',{name:'1페이지'})).toBeTruthy();expect(screen.getAllByText('2 / 5')).toHaveLength(2);
    await act(async()=>pending.get('https://app.lakomics.local/media-cache/page-1')?.());
    await screen.findByRole('img',{name:'2페이지'});expect(document.querySelector('[data-page="1"]')).toBe(preloaded);
    expect(mocks.native.mock.calls.filter(([op,payload])=>op==='catalogImage'&&payload.index===1)).toHaveLength(1);
    fireEvent.click(screen.getByRole('button',{name:'이전 페이지'}));await screen.findByRole('img',{name:'1페이지'});expect(mocks.native.mock.calls.filter(([op,payload])=>op==='catalogImage'&&payload.index===0)).toHaveLength(1);
  });
  it('uses portrait single pages and Japanese landscape spreads without stretching the cover',async()=>{
    Object.defineProperty(window,'innerWidth',{configurable:true,value:1280});Object.defineProperty(window,'innerHeight',{configurable:true,value:800});
    render(<Catalog active paused={false} backRef={{current:null}}/>);fireEvent.click(await screen.findByText('밤의 도서관'));fireEvent.click(await screen.findByRole('button',{name:'읽기'}));
    await screen.findByRole('img',{name:'1페이지'});
    expect((document.querySelector('.catalog-reader-leaf') as HTMLElement).style.flexBasis).toBe('50%');
    expect(document.querySelector('.catalog-reader-blank')).toBeTruthy();
    fireEvent.click(screen.getByRole('button',{name:'다음 페이지'}));await screen.findByRole('img',{name:'3페이지'});
    expect(screen.getAllByText('2–3 / 5')).toHaveLength(2);expect(document.querySelector('.catalog-reader-blank')).toBeNull();
    const visible=[...document.querySelectorAll<HTMLElement>('.catalog-reader-leaf')].filter(e=>e.style.display!=='none');
    expect(visible).toHaveLength(2);expect(visible.map(e=>e.style.flexBasis)).toEqual(['50%','50%']);
  });
  it('starts with Today popular sorting',async()=>{
    render(<Catalog active paused={false} backRef={{current:null}}/>);await screen.findByText('밤의 도서관');expect(screen.getByRole('button',{name:/^카탈로그 정렬/}).textContent).toBe(CHOICES['hotDay']);
  });
  it('observes the reader stage after the dialog portal mounts',async()=>{
    const observe=vi.fn(),disconnect=vi.fn();const previous=window.ResizeObserver;
    window.ResizeObserver=class {observe=observe;disconnect=disconnect;unobserve=vi.fn();} as unknown as typeof ResizeObserver;
    try{render(<Catalog active paused={false} backRef={{current:null}}/>);fireEvent.click(await screen.findByText('밤의 도서관'));fireEvent.click(await screen.findByRole('button',{name:'읽기'}));
      await screen.findByRole('button',{name:'읽기 닫기'});await waitFor(()=>expect(observe).toHaveBeenCalledWith(document.querySelector('.catalog-reader-stage')));
    }finally{cleanup();window.ResizeObserver=previous;}
  });
  it('opens the reader, prefetches only nearby pages, and backs out to detail',async()=>{
    const backRef:{current:(()=>boolean)|null}={current:null};render(<Catalog active paused={false} backRef={backRef}/>);
    fireEvent.click(await screen.findByText('밤의 도서관'));await screen.findByRole('button',{name:'읽기'});fireEvent.click(screen.getByRole('button',{name:'읽기'}));
    await screen.findByRole('button',{name:'읽기 닫기'});expect(mocks.api.mock.calls.some(([path])=>path.includes('/works/kHentai/42/reader?context=context'))).toBe(true);
    await waitFor(()=>expect(mocks.native.mock.calls.filter(([op])=>op==='catalogImage').length).toBeLessThanOrEqual(3));
    act(()=>{expect(backRef.current?.()).toBe(true);});expect(screen.queryByRole('button',{name:'읽기 닫기'})).toBeNull();expect(screen.getByText('40페이지 · 조회 1,200')).toBeTruthy();
  });
  it('shows one page at a time, advances with the next control, without storing reading position',async()=>{
    render(<Catalog active paused={false} backRef={{current:null}}/>);fireEvent.click(await screen.findByText('밤의 도서관'));await screen.findByRole('button',{name:'읽기'});fireEvent.click(screen.getByRole('button',{name:'읽기'}));
    await screen.findByRole('button',{name:'다음 페이지'});expect(screen.getAllByText('1 / 5').length).toBeGreaterThan(0);
    fireEvent.click(screen.getByRole('button',{name:'다음 페이지'}));await waitFor(()=>expect(screen.getAllByText('2 / 5').length).toBeGreaterThan(0));
    expect(localStorage.getItem('lakomics.catalog.reading.kHentai:42')).toBeNull();expect((screen.getByRole('button',{name:'이전 페이지'}) as HTMLButtonElement).disabled).toBe(false);
  });
  it('keeps reader chrome hidden while swiping, shows it only on tap, and supports pinch zoom',async()=>{
    render(<Catalog active paused={false} backRef={{current:null}}/>);fireEvent.click(await screen.findByText('밤의 도서관'));await screen.findByRole('button',{name:'읽기'});fireEvent.click(screen.getByRole('button',{name:'읽기'}));
    await screen.findByRole('button',{name:'다음 페이지'});const reader=document.querySelector('.catalog-reader')!,stage=document.querySelector('.catalog-reader-stage') as HTMLElement;
    expect(reader.classList.contains('chrome-visible')).toBe(false);
    fireEvent.pointerDown(stage,{pointerId:1,button:0,clientX:800,clientY:400});fireEvent.pointerMove(stage,{pointerId:1,clientX:950,clientY:400});fireEvent.pointerUp(stage,{pointerId:1,clientX:950,clientY:400});
    await waitFor(()=>expect(screen.getAllByText('2 / 5').length).toBeGreaterThan(0));expect(reader.classList.contains('chrome-visible')).toBe(false);
    fireEvent.pointerDown(stage,{pointerId:2,button:0,clientX:500,clientY:400});fireEvent.pointerUp(stage,{pointerId:2,clientX:500,clientY:400});expect(reader.classList.contains('chrome-visible')).toBe(true);
    Object.defineProperty(stage,'getBoundingClientRect',{configurable:true,value:()=>({left:0,top:0,right:1000,bottom:800,width:1000,height:800,x:0,y:0,toJSON:()=>({})})});
    fireEvent.pointerDown(stage,{pointerId:3,button:0,clientX:300,clientY:400});fireEvent.pointerDown(stage,{pointerId:4,button:0,clientX:700,clientY:400});fireEvent.pointerMove(stage,{pointerId:4,clientX:900,clientY:400});
    await waitFor(()=>expect((document.querySelector('.catalog-reader-spread') as HTMLElement).style.transform).toContain('scale(1.5)'));expect(screen.getByRole('button',{name:'화면에 맞추기'})).toBeTruthy();
  });
  it('refreshes an expired reader manifest only once when nearby pages fail together',async()=>{
    mocks.native.mockRejectedValue(new Error('expired'));
    render(<Catalog active paused={false} backRef={{current:null}}/>);fireEvent.click(await screen.findByText('밤의 도서관'));await screen.findByRole('button',{name:'읽기'});fireEvent.click(screen.getByRole('button',{name:'읽기'}));
    await screen.findByRole('button',{name:'읽기 닫기'});
    await waitFor(()=>expect(mocks.api.mock.calls.filter(([path])=>path.includes('/reader?'))).toHaveLength(2));
    await new Promise(resolve=>setTimeout(resolve,20));expect(mocks.api.mock.calls.filter(([path])=>path.includes('/reader?'))).toHaveLength(2);
  });
  it('forces latest sort when bookmark scope is enabled',async()=>{
    render(<Catalog active paused={false} backRef={{current:null}}/>);await screen.findByText('밤의 도서관');
    choose('카탈로그 정렬','views');await waitFor(()=>expect(screen.getByRole('button',{name:/^카탈로그 정렬/}).textContent).toBe(CHOICES['views']));
    fireEvent.click(screen.getByRole('button',{name:'북마크',exact:true}));await waitFor(()=>expect(screen.getByRole('button',{name:/^카탈로그 정렬/}).textContent).toBe(CHOICES['latest']));
    expect(mocks.api.mock.calls.some(([path])=>path.includes('scope=bookmarked')&&path.includes('sort=latest'))).toBe(true);
  });
  it('uses a ready total without issuing the extra count request',async()=>{
    mocks.api.mockImplementation(async(path:string)=>path.includes('/status')?{publicationRevision:'p1'}:{...page,countToken:null,totalCount:1,countStatus:'ready'});
    render(<Catalog active paused={false} backRef={{current:null}}/>);
    await screen.findByText('1',{selector:'.catalog-total'});expect(mocks.api.mock.calls.some(([path])=>path.includes('/count?'))).toBe(false);
  });
  it('distinguishes unpublished from a published empty search',async()=>{
    let published=false;
    mocks.api.mockImplementation(async(path:string)=>path.includes('/status')?{publicationRevision:'p1'}:published?{...page,items:[],countToken:null,totalCount:0,countStatus:'ready'}:{...page,ready:false,items:[],countToken:null});
    render(<Catalog active paused={false} backRef={{current:null}}/>);await screen.findByText('카탈로그가 아직 공유되지 않았습니다');published=true;
    fireEvent.click(screen.getByRole('button',{name:'카탈로그 새로고침'}));await screen.findByText('검색 결과가 없습니다');expect(screen.queryByText('카탈로그가 아직 공유되지 않았습니다')).toBeNull();
  });
  it('resumes an aborted count without fetching the retained page again',async()=>{
    let countCalls=0;mocks.api.mockImplementation(async(path:string)=>{
      if(path.includes('/count?')){countCalls++;if(countCalls===1)return new Promise(()=>{});return {publicationRevision:'p1',totalCount:1};}
      return page;
    });
    const backRef={current:null};const view=render(<Catalog active paused={false} backRef={backRef}/>);await screen.findByText('밤의 도서관');
    await waitFor(()=>expect(countCalls).toBe(1));view.rerender(<Catalog active={false} paused={false} backRef={backRef}/>);view.rerender(<Catalog active paused={false} backRef={backRef}/>);
    await screen.findByText('1',{selector:'.catalog-total'});expect(mocks.api.mock.calls.filter(([p])=>p.includes('/search?'))).toHaveLength(1);
  });
  it('disables retained cards while a replacement query is pending',async()=>{
    render(<Catalog active paused={false} backRef={{current:null}}/>);await screen.findByText('밤의 도서관');await screen.findByText('1',{selector:'.catalog-total'});
    mocks.api.mockImplementation(()=>new Promise(()=>{}));choose('카탈로그 언어','japanese');
    expect((screen.getByText('밤의 도서관').closest('button') as HTMLButtonElement).disabled).toBe(true);
    fireEvent.click(screen.getByText('밤의 도서관'));expect(screen.queryByText('상세 정보')).toBeNull();
  });
  it('opens Catalog settings from the top bar and applies several categories in one request',async()=>{
    render(<Catalog active paused={false} backRef={{current:null}}/>);await screen.findByText('밤의 도서관');
    // Only the top-bar icon opens settings; the gallery has no second filter control.
    expect(screen.getAllByRole('button',{name:/^필터/})).toHaveLength(1);
    fireEvent.click(screen.getByRole('button',{name:/^필터/}));
    const panel=await screen.findByRole('dialog',{name:'필터'});
    expect(panel).toBeTruthy();
    // Every category starts included, so narrowing means unchecking the rest. The
    // whole set is composed in one read, not one request per tap.
    for(const label of ['게임 CG','서양','이미지 세트','비성인','코스프레','아시아 포르노','기타','비공개'])fireEvent.click(screen.getByLabelText(label));
    expect(mocks.api.mock.calls.filter(([path])=>(path as string).includes('/search?')).length).toBe(1);
    fireEvent.click(screen.getByRole('button',{name:'적용'}));
    await waitFor(()=>expect(searchParams(lastSearch()).get('categories')).toBe('[1,2,3]'));
    // The user's own query text is untouched by the selector.
    expect(searchParams(lastSearch()).get('text')).toBe('');
  });
  it('shows every category checked by default and starts a selection from all',async()=>{
    render(<Catalog active paused={false} backRef={{current:null}}/>);await screen.findByText('밤의 도서관');
    fireEvent.click(screen.getByRole('button',{name:/^필터/}));await screen.findByRole('dialog',{name:'필터'});
    // "No restriction" is presented as all categories checked.
    for(const label of ['동인지','만화','아티스트 CG','비공개'])expect((screen.getByLabelText(label) as HTMLInputElement).checked).toBe(true);
    // Unchecking one starts a concrete selection from all, not from nothing.
    fireEvent.click(screen.getByLabelText('만화'));
    fireEvent.click(screen.getByRole('button',{name:'적용'}));
    await waitFor(()=>expect(searchParams(lastSearch()).get('categories')).toBe('[1,3,4,5,6,7,8,9,10,11]'));
    // The panel offers one way back to no restriction.
    fireEvent.click(screen.getByRole('button',{name:/^필터/}));await screen.findByRole('dialog',{name:'필터'});
    fireEvent.click(screen.getByRole('button',{name:'모두 포함'}));fireEvent.click(screen.getByRole('button',{name:'적용'}));
    await waitFor(()=>expect(mocks.api.mock.calls.filter(([path])=>(path as string).includes('/search?')).at(-1)![0]).not.toContain('categories='));
  });
  it('adds one namespaced avoidance tag, rejects a duplicate, and removes it again',async()=>{
    render(<Catalog active paused={false} backRef={{current:null}}/>);await screen.findByText('밤의 도서관');
    fireEvent.click(screen.getByRole('button',{name:/^필터/}));await screen.findByRole('dialog',{name:'필터'});
    // The user enters one string, not a namespace and value in separate fields.
    fireEvent.change(screen.getByLabelText('회피 태그'),{target:{value:'female:scat'}});
    fireEvent.click(screen.getByRole('button',{name:'추가'}));
    expect(screen.getByText('female:scat')).toBeTruthy();
    fireEvent.change(screen.getByLabelText('회피 태그'),{target:{value:'female:scat'}});
    fireEvent.click(screen.getByRole('button',{name:'추가'}));
    expect(screen.getByText('이미 회피한 태그입니다.')).toBeTruthy();
    fireEvent.click(screen.getByRole('button',{name:'적용'}));
    await waitFor(()=>expect(JSON.parse(searchParams(lastSearch()).get('excludedTags')!)).toEqual([{namespace:'female',value:'scat'}]));
    // A tag value is never sent as the search text.
    expect(searchParams(lastSearch()).get('text')).toBe('');
    fireEvent.click(screen.getByRole('button',{name:/^필터/}));await screen.findByRole('dialog',{name:'필터'});
    expect(screen.getByText('female:scat')).toBeTruthy();
    fireEvent.click(screen.getByRole('button',{name:'female:scat 회피 해제'}));
    fireEvent.click(screen.getByRole('button',{name:'적용'}));
    // Removing the only tag returns to the unfiltered identity.
    await waitFor(()=>expect(mocks.api.mock.calls.filter(([path])=>(path as string).includes('/search?')).at(-1)![0]).not.toContain('excludedTags='));
  });
  it('refuses a tag set that would exceed the combined encoded filter budget',async()=>{
    render(<Catalog active paused={false} backRef={{current:null}}/>);await screen.findByText('밤의 도서관');
    fireEvent.click(screen.getByRole('button',{name:/^필터/}));await screen.findByRole('dialog',{name:'필터'});
    const entry=screen.getByLabelText('회피 태그');
    const value='x'.repeat(60);
    for(let index=0;index<40;index++){
      fireEvent.change(entry,{target:{value:`artist:${value}${index}`}});
      fireEvent.click(screen.getByRole('button',{name:'추가'}));
    }
    // The over-budget add is refused, so the stored set stays inside the budget.
    await waitFor(()=>expect(screen.getAllByText(/회피 태그가 너무 많습니다/).length).toBeGreaterThan(0));
    fireEvent.click(screen.getByRole('button',{name:'적용'}));
    await waitFor(()=>expect(searchParams(lastSearch()).has('excludedTags')).toBe(true));
    const encoded=searchParams(lastSearch()).get('excludedTags')!;
    expect(encoded.length).toBeLessThanOrEqual(2048);
    expect(JSON.parse(encoded).length).toBeLessThan(40);
  });
  it('re-reads detail after a filter is applied instead of serving the wider cached work',async()=>{
    render(<Catalog active paused={false} backRef={{current:null}}/>);await screen.findByText('밤의 도서관');
    // Read the detail under no restriction: it is cached for that filter identity.
    fireEvent.click(screen.getByText('밤의 도서관'));await screen.findByText('40페이지 · 조회 1,200');
    fireEvent.click(screen.getByRole('button',{name:'카탈로그 목록으로'}));
    const before=mocks.api.mock.calls.filter(([path])=>(path as string).includes('/works/kHentai/42?')).length;
    // A narrower filter is applied: the work may no longer be eligible, so the old
    // detail response must not be reused for the new filter identity.
    fireEvent.click(screen.getByRole('button',{name:/^필터/}));await screen.findByRole('dialog',{name:'필터'});
    for(const label of ['동인지','만화','아티스트 CG','서양','이미지 세트','비성인','코스프레','아시아 포르노','기타','비공개'])fireEvent.click(screen.getByLabelText(label));
    fireEvent.click(screen.getByRole('button',{name:'적용'}));
    await waitFor(()=>expect(searchParams(lastSearch()).get('categories')).toBe('[4]'));
    fireEvent.click(screen.getByText('밤의 도서관'));
    await waitFor(()=>expect(mocks.api.mock.calls.filter(([path])=>(path as string).includes('/works/kHentai/42?')).length).toBeGreaterThan(before));
  });
  it('leaves page, cursor and scroll untouched when the setting did not change',async()=>{
    render(<Catalog active paused={false} backRef={{current:null}}/>);await screen.findByText('밤의 도서관');await screen.findByText('1',{selector:'.catalog-total'});
    const list=document.querySelector('.catalog-scroll') as HTMLElement;list.scrollTop=140;fireEvent.scroll(list);
    const searches=mocks.api.mock.calls.filter(([path])=>(path as string).includes('/search?')).length;
    // Apply without changing anything: this is not a filter change.
    fireEvent.click(screen.getByRole('button',{name:/^필터/}));await screen.findByRole('dialog',{name:'필터'});
    fireEvent.click(screen.getByRole('button',{name:'적용'}));
    await act(async()=>{});
    expect(mocks.api.mock.calls.filter(([path])=>(path as string).includes('/search?')).length).toBe(searches);
    expect(list.scrollTop).toBe(140);
    expect(screen.getByText('밤의 도서관')).toBeTruthy();
  });
  it('hides the settings icon while the detail or reader is open',async()=>{
    render(<Catalog active paused={false} backRef={{current:null}}/>);await screen.findByText('밤의 도서관');
    expect(screen.getByRole('button',{name:/^필터/})).toBeTruthy();
    fireEvent.click(screen.getByText('밤의 도서관'));await screen.findByText('40페이지 · 조회 1,200');
    expect(screen.queryByRole('button',{name:/^필터/})).toBeNull();
    fireEvent.click(screen.getByRole('button',{name:'읽기'}));await screen.findByRole('button',{name:'읽기 닫기'});
    expect(screen.queryByRole('button',{name:/^필터/})).toBeNull();
  });
  it('sends searchMode=mobile only after the server advertises the capability',async()=>{
    mocks.api.mockImplementation(async(path:string)=>path.includes('/status')?capableStatus:path.includes('/count?')?{publicationRevision:'p1',totalCount:1}:page);
    render(<Catalog active paused={false} backRef={{current:null}}/>);await screen.findByText('밤의 도서관');
    await waitFor(()=>expect(searchParams(lastSearch()).get('searchMode')).toBe('mobile'));
  });
  it('keeps the old parameters against a server without the capability',async()=>{
    mocks.api.mockImplementation(async(path:string)=>path.includes('/status')?legacyStatus:path.includes('/count?')?{publicationRevision:'p1',totalCount:1}:page);
    render(<Catalog active paused={false} backRef={{current:null}}/>);await screen.findByText('밤의 도서관');
    expect(searchParams(lastSearch()).has('searchMode')).toBe(false);
    expect([...searchParams(lastSearch()).keys()]).toEqual(['provider','language','text','sort','scope','revealBlocked','limit']);
  });
  it('searches the typed text when the keyboard Search/Enter key submits the form',async()=>{
    // The IME Search key is an implicit form submission: the browser activates the
    // form's first submit button. The clear (X) button must not be that button.
    const user=userEvent.setup();
    render(<Catalog active paused={false} backRef={{current:null}}/>);await screen.findByText('밤의 도서관');
    const search=screen.getByRole('textbox',{name:'카탈로그 검색'}) as HTMLInputElement;
    await user.type(search,'john doe{Enter}');
    await waitFor(()=>expect(searchParams(lastSearch()).get('text')).toBe('john doe'));
    expect(search.value).toBe('john doe');
    // A second search after a committed one must not be reset to the empty query either.
    await user.type(search,' x{Enter}');
    await waitFor(()=>expect(searchParams(lastSearch()).get('text')).toBe('john doe x'));
    expect(search.value).toBe('john doe x');
  });
  it('searches newest first under a popular sort and restores that sort when the search is cleared',async()=>{
    // 오늘 인기 only covers works posted in the last day, so `artist:x` would find nothing.
    const user=userEvent.setup();
    render(<Catalog active paused={false} backRef={{current:null}}/>);await screen.findByText('밤의 도서관');
    const sortChip=()=>screen.getByRole('button',{name:/^카탈로그 정렬/});
    expect(sortChip().textContent).toBe(CHOICES['hotDay']);
    await user.type(screen.getByRole('textbox',{name:'카탈로그 검색'}),'artist:peachbitch{Enter}');
    await waitFor(()=>expect(searchParams(lastSearch()).get('text')).toBe('artist:peachbitch'));
    expect(searchParams(lastSearch()).get('sort')).toBe('latest');
    expect(sortChip().textContent).toBe(CHOICES['latest']);
    expect(screen.getByText('검색 중에는 최신순으로 표시합니다')).toBeTruthy();
    // A sort picked during the search applies to it, and the note no longer claims otherwise.
    choose('카탈로그 정렬','views');
    await waitFor(()=>expect(searchParams(lastSearch()).get('sort')).toBe('views'));
    expect(screen.queryByText('검색 중에는 최신순으로 표시합니다')).toBeNull();
    fireEvent.click(screen.getByRole('button',{name:'검색어 지우기'}));
    // The unfiltered hotDay page is already cached, so the restored sort is read from the chip.
    await waitFor(()=>expect(sortChip().textContent).toBe(CHOICES['hotDay']));
    expect((screen.getByRole('textbox',{name:'카탈로그 검색'}) as HTMLInputElement).value).toBe('');
    expect(screen.queryByText('검색 중에는 최신순으로 표시합니다')).toBeNull();
  });
  it('preserves the unsent draft when the settings panel is applied',async()=>{
    render(<Catalog active paused={false} backRef={{current:null}}/>);await screen.findByText('밤의 도서관');
    const search=screen.getByRole('textbox',{name:'카탈로그 검색'}) as HTMLInputElement;
    fireEvent.change(search,{target:{value:'artist:"작가" AND tag:"밤"'}});
    fireEvent.click(screen.getByRole('button',{name:/^필터/}));await screen.findByRole('dialog',{name:'필터'});
    for(const label of ['동인지','아티스트 CG','게임 CG','서양','이미지 세트','비성인','코스프레','아시아 포르노','기타','비공개'])fireEvent.click(screen.getByLabelText(label));
    fireEvent.click(screen.getByRole('button',{name:'적용'}));
    await waitFor(()=>expect(searchParams(lastSearch()).get('categories')).toBe('[2]'));
    // The draft is neither discarded nor quietly committed by the filter apply.
    expect((screen.getByRole('textbox',{name:'카탈로그 검색'}) as HTMLInputElement).value).toBe('artist:"작가" AND tag:"밤"');
    expect(searchParams(lastSearch()).get('text')).toBe('');
    fireEvent.submit(screen.getByRole('search'));
    await waitFor(()=>expect(searchParams(lastSearch()).get('text')).toBe('artist:"작가" AND tag:"밤"'));
    expect(searchParams(lastSearch()).get('categories')).toBe('[2]');
  });
  it('resets to the first page and clears cursors only when the filter is applied',async()=>{
    render(<Catalog active paused={false} backRef={{current:null}}/>);await screen.findByText('밤의 도서관');
    fireEvent.click(screen.getByRole('button',{name:/^필터/}));await screen.findByRole('dialog',{name:'필터'});
    for(const label of ['동인지','만화','아티스트 CG','서양','이미지 세트','비성인','코스프레','아시아 포르노','기타','비공개'])fireEvent.click(screen.getByLabelText(label));
    // An unapplied draft changes nothing on the wire.
    expect(mocks.api.mock.calls.filter(([path])=>searchParams(path as string).has('categories'))).toHaveLength(0);
    fireEvent.click(screen.getByRole('button',{name:'적용'}));
    await waitFor(()=>expect(searchParams(lastSearch()).get('categories')).toBe('[4]'));
    const cursorOnly=mocks.api.mock.calls.filter(([path])=>(path as string).includes('/search?')&&searchParams(path as string).has('cursor'));
    expect(cursorOnly).toHaveLength(0);
  });
  it('closes settings with Back and Escape before leaving the catalog, preserving scroll',async()=>{
    const backRef={current:null};render(<Catalog active paused={false} backRef={backRef}/>);await screen.findByText('밤의 도서관');
    const list=document.querySelector('.catalog-scroll') as HTMLElement;list.scrollTop=120;fireEvent.scroll(list);
    fireEvent.click(screen.getByRole('button',{name:/^필터/}));await screen.findByRole('dialog',{name:'필터'});
    // Back closes the modal and does not consume the catalog's own back step.
    act(()=>{expect(backRef.current?.()).toBe(true);});expect(screen.queryByRole('dialog',{name:'필터'})).toBeNull();
    expect(screen.getByText('밤의 도서관')).toBeTruthy();expect(list.scrollTop).toBe(120);
    fireEvent.click(screen.getByRole('button',{name:/^필터/}));await screen.findByRole('dialog',{name:'필터'});
    fireEvent.keyDown(document.activeElement??document.body,{key:'Escape'});
    await waitFor(()=>expect(screen.queryByRole('dialog',{name:'필터'})).toBeNull());
    expect(backRef.current?.()).toBe(false);
  });
  it('persists the device filter per endpoint and restores it after re-entering',async()=>{
    mocks.api.mockImplementation(async(path:string)=>path.includes('/status')?capableStatus:path.includes('/count?')?{publicationRevision:'p1',totalCount:1}:path.includes('/works/')?{publicationRevision:'p1',item:{...item,tagGroups:[],uploader:null,category:1,updated:null,fileSize:null,rating:null}}:page);
    const backRef={current:null};const view=render(<Catalog active paused={false} backRef={backRef} endpoint="https://a.invalid"/>);await screen.findByText('밤의 도서관');
    fireEvent.click(screen.getByRole('button',{name:/^필터/}));await screen.findByRole('dialog',{name:'필터'});
    fireEvent.click(screen.getByLabelText('만화'));fireEvent.click(screen.getByRole('button',{name:'적용'}));
    await waitFor(()=>expect(searchParams(lastSearch()).get('categories')).toBe('[1,3,4,5,6,7,8,9,10,11]'));
    expect(localStorage.getItem('lakomics.catalog.preferences.https://a.invalid')).toBeTruthy();
    view.rerender(<Catalog active={false} paused={false} backRef={backRef} endpoint="https://a.invalid"/>);
    view.rerender(<Catalog active paused={false} backRef={backRef} endpoint="https://a.invalid"/>);
    await waitFor(()=>expect(searchParams(lastSearch()).get('categories')).toBe('[1,3,4,5,6,7,8,9,10,11]'));
    // Another server never inherits the first server's filters.
    view.rerender(<Catalog active={false} paused={false} backRef={backRef} endpoint="https://b.invalid"/>);
    view.rerender(<Catalog active paused={false} backRef={backRef} endpoint="https://b.invalid"/>);
    await screen.findByText('밤의 도서관');
    await waitFor(()=>expect(searchParams(lastSearch()).has('categories')).toBe(false));
  });
  it('applies a restored setting on the very first request instead of showing an unfiltered list',async()=>{
    localStorage.setItem('lakomics.catalog.preferences.https://a.invalid',JSON.stringify({categories:[2],excludedTags:[{namespace:'female',value:'scat'}]}));
    render(<Catalog active paused={false} backRef={{current:null}} endpoint="https://a.invalid"/>);
    await screen.findByText('밤의 도서관');
    // The stored setting reaches the wire on the first read, not only after the panel is opened.
    expect(searchParams(lastSearch()).get('categories')).toBe('[2]');
    expect(JSON.parse(searchParams(lastSearch()).get('excludedTags')!)).toEqual([{namespace:'female',value:'scat'}]);
  });
  it('retries a failed capability check instead of leaving the list blank forever',async()=>{
    let statusCalls=0;
    mocks.api.mockImplementation(async(path:string)=>{
      if(!path.includes('/status'))return path.includes('/count?')?{publicationRevision:'p1',totalCount:1}:page;
      if(++statusCalls===1)throw new Error('status unavailable');
      return capableStatus;
    });
    render(<Catalog active paused={false} backRef={{current:null}}/>);
    await screen.findByText('서버 상태를 확인하지 못했습니다');
    // A failed check must not launch a search with an unverified contract.
    expect(mocks.api.mock.calls.filter(([path])=>(path as string).includes('/search?'))).toHaveLength(0);
    expect(screen.queryByText('이 기기의 설정을 쓸 수 없습니다')).toBeNull();
    fireEvent.click(screen.getByRole('button',{name:'다시 시도'}));
    await screen.findByText('밤의 도서관');
    expect(searchParams(lastSearch()).get('searchMode')).toBe('mobile');
  });
  it('distinguishes checking from an unsupported server',async()=>{
    // A stored setting is only blocked once a server actually answered without the
    // capability; while the check is outstanding the list is not silently unfiltered.
    localStorage.setItem('lakomics.catalog.preferences.https://a.invalid',JSON.stringify({categories:[1],excludedTags:[]}));
    const pending=Promise.withResolvers<unknown>();
    mocks.api.mockImplementation(async(path:string)=>path.includes('/status')?pending.promise:page);
    render(<Catalog active paused={false} backRef={{current:null}} endpoint="https://a.invalid"/>);
    await screen.findByText('카탈로그를 준비하는 중입니다');
    expect(mocks.api.mock.calls.filter(([path])=>(path as string).includes('/search?'))).toHaveLength(0);
    await act(async()=>pending.resolve(legacyStatus));
    await screen.findByText('이 기기의 설정을 쓸 수 없습니다');
  });
  it('clears stored settings only when the user asks, and then browses unfiltered',async()=>{
    localStorage.setItem('lakomics.catalog.preferences.https://a.invalid',JSON.stringify({categories:[1],excludedTags:[]}));
    mocks.api.mockImplementation(async(path:string)=>path.includes('/status')?legacyStatus:path.includes('/count?')?{publicationRevision:'p1',totalCount:1}:page);
    render(<Catalog active paused={false} backRef={{current:null}} endpoint="https://a.invalid"/>);
    await screen.findByText('이 기기의 설정을 쓸 수 없습니다');
    // The stored setting is neither discarded nor bypassed before the user decides.
    expect(screen.queryByText('밤의 도서관')).toBeNull();
    expect(localStorage.getItem('lakomics.catalog.preferences.https://a.invalid')).toBeTruthy();
    expect(mocks.api.mock.calls.filter(([path])=>(path as string).includes('/search?'))).toHaveLength(0);
    fireEvent.click(screen.getByRole('button',{name:'설정 지우고 계속'}));
    await screen.findByText('밤의 도서관');
    expect(localStorage.getItem('lakomics.catalog.preferences.https://a.invalid')).toBeNull();
    expect(searchParams(lastSearch()).has('categories')).toBe(false);
  });
});
describe('mobile catalog layout',()=>{
  const second:CatalogItem={...item,providerWorkId:'43',groupId:'group-2',title:'계절의 기록',versionCount:1,bookmarked:false,hasBookmarkedVersion:false};
  it('appends the next cursor page while scrolling and restarts when the publication changes',async()=>{
    mocks.api.mockImplementation(async(path:string)=>{
      if(path.includes('/status'))return capableStatus;
      if(path.includes('/count?'))return {publicationRevision:'p1',totalCount:2};
      if(path.includes('cursor=c2'))return {...page,items:[second],nextCursor:null};
      if(path.includes('cursor=j2'))return {...page,publicationRevision:'p2',items:[{...second,title:'다른 게시본'}],nextCursor:null};
      // Real cursors are opaque and carry the query, so each language has its own.
      return {...page,nextCursor:searchParams(path).get('language')==='japanese'?'j2':'c2'};
    });
    render(<Catalog active paused={false} backRef={{current:null}}/>);await screen.findByText('밤의 도서관');
    // jsdom has no layout, so the short first page already counts as scrolled to the end.
    await screen.findByText('계절의 기록');expect(screen.getByText('밤의 도서관')).toBeTruthy();
    expect(screen.getByText('마지막 작품입니다')).toBeTruthy();
    expect(screen.queryByRole('button',{name:'이전'})).toBeNull();expect(screen.queryByRole('button',{name:'다음'})).toBeNull();
    // A page from another publication is never mixed into the list; the list starts over.
    mocks.api.mockClear();
    fireEvent.click(screen.getByRole('button',{name:/^카탈로그 언어/}));fireEvent.click(screen.getByRole('radio',{name:'일본어'}));
    await waitFor(()=>expect(mocks.api.mock.calls.some(([path])=>(path as string).includes('cursor=j2'))).toBe(true));
    await waitFor(()=>expect(mocks.api.mock.calls.filter(([path])=>(path as string).includes('/search?')&&!(path as string).includes('cursor=')).length).toBeGreaterThanOrEqual(2));
    expect(screen.queryByText('다른 게시본')).toBeNull();
    // The stale first page is not reloaded in a loop.
    await screen.findByText('목록이 갱신되었습니다. 당겨서 새로고침해 주세요.');
  });
  it('counts active filters on the chip and applies the blocked switch from the filter sheet',async()=>{
    render(<Catalog active paused={false} backRef={{current:null}}/>);await screen.findByText('밤의 도서관');
    expect(screen.getByRole('button',{name:'필터'})).toBeTruthy();
    fireEvent.click(screen.getByRole('button',{name:'필터'}));await screen.findByRole('dialog',{name:'필터'});
    const blocked=screen.getByRole('switch',{name:/차단 항목 보기/});expect(blocked.getAttribute('aria-checked')).toBe('false');
    fireEvent.click(blocked);fireEvent.change(screen.getByLabelText('회피 태그'),{target:{value:'female:scat'}});fireEvent.click(screen.getByRole('button',{name:'추가'}));
    fireEvent.click(screen.getByRole('button',{name:'적용'}));
    await waitFor(()=>expect(searchParams(lastSearch()).get('revealBlocked')).toBe('true'));
    expect(screen.getByRole('button',{name:'필터 2개 적용'})).toBeTruthy();
    expect(screen.queryByText('PC 공통 정책의 차단 항목 보기')).toBeNull();
  });
  it('shows how long ago the catalog was published and offers the server refresh in the title bar',async()=>{
    const publishedAt=new Date(Date.now()-23*60_000).toISOString();
    mocks.api.mockImplementation(async(path:string)=>{
      if(path.includes('/status'))return {...capableStatus,capabilities:{...capableStatus.capabilities,refreshRequest:true}};
      if(path.includes('/refresh'))return {job:null};
      if(path.includes('/count?'))return {publicationRevision:'p1',totalCount:1};
      return {...page,publishedAt};
    });
    render(<Catalog active paused={false} backRef={{current:null}}/>);await screen.findByText('밤의 도서관');
    await screen.findByText('23분 전 갱신');expect(await screen.findByRole('button',{name:'새 작품 가져오기'})).toBeTruthy();
  });
  it('offers only Read and starts at the cover even when old progress exists',async()=>{
    localStorage.setItem('lakomics.catalog.reading.kHentai:42','11');
    render(<Catalog active paused={false} backRef={{current:null}}/>);fireEvent.click(await screen.findByText('밤의 도서관'));
    const read=await screen.findByRole('button',{name:'읽기'});
    expect(screen.queryByRole('button',{name:/이어\s*읽기/})).toBeNull();
    expect(screen.getByText('태그를 누르면 같은 태그로 검색합니다.')).toBeTruthy();
    fireEvent.click(read);await screen.findByRole('img',{name:'1페이지'});
    fireEvent.click(screen.getByRole('button',{name:'다음 페이지'}));await screen.findByRole('img',{name:'2페이지'});
    fireEvent.click(screen.getByRole('button',{name:'읽기 닫기'}));
    fireEvent.click(await screen.findByRole('button',{name:'읽기'}));await screen.findByRole('img',{name:'1페이지'});
    expect(localStorage.getItem('lakomics.catalog.reading.kHentai:42')).toBe('11');
  });
});
describe('mobile catalog tag autocomplete',()=>{
  const suggestStatus={...capableStatus,capabilities:{...capableStatus.capabilities,suggestions:true}};
  const suggestionCalls=()=>mocks.api.mock.calls.map(([path])=>path as string).filter(path=>path.includes('/suggestions?'));
  const settle=()=>act(()=>new Promise(resolve=>setTimeout(resolve,250)));
  const options=[{value:'artist:asanagi',label:null,count:1234},{value:'female:big breasts',label:'큰 가슴',count:88}];
  function serve(status:object,suggest:(path:string)=>unknown=()=>({ready:true,publicationRevision:'p1',items:options})){
    const fallback=mocks.api.getMockImplementation()!;
    mocks.api.mockImplementation(async(path:string,signal?:AbortSignal)=>path.includes('/status')?status:path.includes('/suggestions?')?suggest(path):fallback(path,signal));
  }
  async function open(){render(<Catalog active paused={false} backRef={{current:null}}/>);await screen.findByText('밤의 도서관');}
  const type=(role:'textbox'|'combobox',text:string)=>fireEvent.change(screen.getByRole(role,{name:'카탈로그 검색'}),{target:{value:text}});

  it('turns a suggestion into namespace:value, quoting only a value the parser would misread',()=>{
    expect(suggestionQuery('female:big breasts')).toBe('female:big breasts');
    expect(suggestionQuery('artist:foo (bar)')).toBe('artist:"foo (bar)"');
    expect(suggestionQuery('other:-x')).toBe('other:"-x"');
    expect(suggestionQuery('parody:rock or roll')).toBe('parody:"rock or roll"');
  });
  it('asks nothing of a server that does not advertise suggestions',async()=>{
    await open();type('textbox','art');await settle();
    expect(suggestionCalls()).toEqual([]);expect(screen.queryByRole('listbox')).toBeNull();
  });
  it('never asks for empty text',async()=>{
    serve(suggestStatus);await open();
    type('combobox','   ');await settle();
    expect(suggestionCalls()).toEqual([]);
  });
  it('debounces keystrokes into one request for the latest text, limited to 10',async()=>{
    serve(suggestStatus);await open();
    type('combobox','a');type('combobox','a:');type('combobox','a:asa');
    await screen.findByRole('listbox',{name:'태그 추천'});
    expect(suggestionCalls()).toHaveLength(1);
    expect(searchParams(suggestionCalls()[0]).get('text')).toBe('a:asa');
    expect(searchParams(suggestionCalls()[0]).get('limit')).toBe('10');
    expect(screen.getAllByRole('option').map(option=>option.textContent)).toEqual(['artist:asanagi1,234','female:big breasts큰 가슴88']);
  });
  it('drops a reply that arrives after a newer request',async()=>{
    const replies:Record<string,PromiseWithResolvers<unknown>>={};
    serve(suggestStatus,path=>{const text=searchParams(path).get('text')!;replies[text]=Promise.withResolvers();return replies[text].promise;});
    await open();
    type('combobox','fo');await waitFor(()=>expect(suggestionCalls()).toHaveLength(1));
    type('combobox','foo');await waitFor(()=>expect(suggestionCalls()).toHaveLength(2));
    await act(async()=>replies['foo'].resolve({items:[{value:'artist:foo',label:null,count:2}]}));
    await act(async()=>replies['fo'].resolve({items:[{value:'artist:fox',label:null,count:9}]}));
    expect(screen.getAllByRole('option').map(option=>option.textContent)).toEqual(['artist:foo2']);
  });
  it('runs the search for a tapped suggestion, newest first, and closes the list',async()=>{
    serve(suggestStatus);await open();
    type('combobox','big');fireEvent.click(await screen.findByRole('option',{name:/female:big breasts/}));
    await waitFor(()=>expect(searchParams(lastSearch()).get('text')).toBe('female:big breasts'));
    expect(searchParams(lastSearch()).get('sort')).toBe('latest');
    expect((screen.getByRole('combobox',{name:'카탈로그 검색'}) as HTMLInputElement).value).toBe('female:big breasts');
    expect(screen.queryByRole('listbox')).toBeNull();
  });
  it('chooses with the arrow keys and Enter, and Escape or blur closes the list',async()=>{
    serve(suggestStatus);await open();
    const input=screen.getByRole('combobox',{name:'카탈로그 검색'});
    type('combobox','a');await screen.findByRole('listbox');
    fireEvent.keyDown(input,{key:'Escape'});expect(screen.queryByRole('listbox')).toBeNull();
    type('combobox','as');await screen.findByRole('listbox');
    fireEvent.blur(input);expect(screen.queryByRole('listbox')).toBeNull();
    type('combobox','asa');await screen.findByRole('listbox');
    fireEvent.keyDown(input,{key:'ArrowDown'});
    expect(screen.getAllByRole('option')[0].getAttribute('aria-selected')).toBe('true');
    expect(input.getAttribute('aria-activedescendant')).toBe('catalog-suggestion-0');
    fireEvent.keyDown(input,{key:'Enter'});
    await waitFor(()=>expect(searchParams(lastSearch()).get('text')).toBe('artist:asanagi'));
  });
});
