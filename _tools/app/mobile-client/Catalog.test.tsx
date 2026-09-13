import {afterEach,beforeEach,describe,it,expect,vi} from 'vitest';
import {act,cleanup,fireEvent,render,screen,waitFor} from '@testing-library/react';
import {Catalog} from './Catalog';
import type {CatalogItem,CatalogPage} from './catalogModel';
const mocks=vi.hoisted(()=>({api:vi.fn(),native:vi.fn(),decode:vi.fn()}));
vi.mock('./media',()=>({decodeImage:mocks.decode}));
vi.mock('./transport',()=>({api:mocks.api,native:mocks.native,errorText:(e:Error)=>e.message}));
const item:CatalogItem={provider:'kHentai',providerWorkId:'42',groupId:'group',title:'밤의 도서관',titleJpn:null,thumbnailUrl:null,artists:['작가'],series:[],fileCount:40,views:1200,posted:1000,bookmarked:true,versionCount:2,hasBookmarkedVersion:true};
const page:CatalogPage={ready:true,publicationRevision:'p1',publishedAt:null,items:[item],nextCursor:null,context:'context',countToken:'count',totalCount:null,countStatus:'pending'};
beforeEach(()=>{Object.defineProperty(window,'innerWidth',{configurable:true,value:800});Object.defineProperty(window,'innerHeight',{configurable:true,value:1280});mocks.decode.mockReset();mocks.decode.mockResolvedValue({naturalWidth:600,naturalHeight:900});localStorage.clear();mocks.api.mockReset();mocks.native.mockReset();mocks.native.mockResolvedValue({url:'data:image/gif;base64,R0lGODlhAQABAAAAACw=',expires_in:240});mocks.api.mockImplementation(async(path:string)=>{
  if(path.includes('/count?'))return {publicationRevision:'p1',totalCount:1};
  if(path.includes('/reader?'))return {publicationRevision:'p1',provider:'kHentai',providerWorkId:'42',manifestExpiresAt:1800000000,pages:[0,1,2,3,4].map(index=>({index,url:`https://a.siam-cdn.net/${index}.webp?expires=1800000000`,name:`${index}.webp`,width:1200,height:1800,expiresAt:1800000000}))};
  if(path.includes('/works/'))return {publicationRevision:'p1',item:{...item,tagGroups:[{namespace:'artist',values:['작가']}],uploader:null,category:1,updated:null,fileSize:null,rating:null}};
  if(path.includes('/editions?'))return {publicationRevision:'p1',groupId:'group',selectedProviderWorkId:null,items:[item],nextCursor:null,totalCount:1};
  return page;
});});
afterEach(cleanup);
describe('mobile catalog reads',()=>{
  it('ignores a reader response after the catalog becomes inactive even if transport ignores abort',async()=>{
    const original=mocks.api.getMockImplementation()!;
    let resolve!:(value:unknown)=>void;
    mocks.api.mockImplementation((path,...args)=>path.includes('/reader?')?new Promise(r=>{resolve=r;}):original(path,...args));
    const backRef={current:null};
    const {rerender}=render(<Catalog active paused={false} backRef={backRef}/>);
    fireEvent.click(await screen.findByText('밤의 도서관'));
    fireEvent.click(await screen.findByRole('button',{name:'읽기'}));
    await waitFor(()=>expect(resolve).toBeTypeOf('function'));
    rerender(<Catalog active={false} paused={false} backRef={backRef}/>);
    await act(async()=>resolve({publicationRevision:'p1',provider:'kHentai',providerWorkId:'42',manifestExpiresAt:1800000000,pages:[]}));
    rerender(<Catalog active paused={false} backRef={backRef}/>);
    expect(screen.queryByRole('button',{name:'읽기 닫기'})).toBeNull();
  });
  it('delivers a usable page while count is pending and keeps it on count failure',async()=>{
    let reject!:(e:Error)=>void;mocks.api.mockImplementation(path=>path.includes('/count?')?new Promise((_,r)=>{reject=r;}):Promise.resolve(page));
    render(<Catalog active paused={false} backRef={{current:null}}/>);await screen.findByText('밤의 도서관');expect(screen.queryByText('개수 확인 중')).toBeNull();
    await waitFor(()=>expect(typeof reject).toBe('function'));await act(async()=>reject(new Error('count unavailable')));expect(screen.getByText('밤의 도서관')).toBeTruthy();expect(screen.queryByText('0개')).toBeNull();await screen.findByText('개수를 확인하지 못했습니다.');
  });
  it('ignores an old query and never sends a bookmark write',async()=>{
    let resolve!:(p:CatalogPage)=>void;mocks.api.mockImplementationOnce(()=>new Promise(r=>{resolve=r;}));
    render(<Catalog active paused={false} backRef={{current:null}}/>);
    fireEvent.change(screen.getByRole('combobox',{name:'카탈로그 언어'}),{target:{value:'japanese'}});await screen.findByText('밤의 도서관');
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
    fireEvent.click(screen.getByRole('button',{name:'다음 페이지'}));expect(screen.getByRole('img',{name:'1페이지'})).toBeTruthy();expect(screen.getAllByText('1 / 5')).toHaveLength(2);
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
    render(<Catalog active paused={false} backRef={{current:null}}/>);await screen.findByText('밤의 도서관');expect((screen.getByRole('combobox',{name:'카탈로그 정렬'}) as HTMLSelectElement).value).toBe('hotDay');
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
  it('shows one page at a time, advances with the next control, and stores reading position',async()=>{
    render(<Catalog active paused={false} backRef={{current:null}}/>);fireEvent.click(await screen.findByText('밤의 도서관'));await screen.findByRole('button',{name:'읽기'});fireEvent.click(screen.getByRole('button',{name:'읽기'}));
    await screen.findByRole('button',{name:'다음 페이지'});expect(screen.getAllByText('1 / 5').length).toBeGreaterThan(0);
    fireEvent.click(screen.getByRole('button',{name:'다음 페이지'}));await waitFor(()=>expect(screen.getAllByText('2 / 5').length).toBeGreaterThan(0));
    expect(localStorage.getItem('lakomics.catalog.reading.kHentai:42')).toBe('1');expect((screen.getByRole('button',{name:'이전 페이지'}) as HTMLButtonElement).disabled).toBe(false);
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
    fireEvent.change(screen.getByRole('combobox',{name:'카탈로그 정렬'}),{target:{value:'views'}});await waitFor(()=>expect((screen.getByRole('combobox',{name:'카탈로그 정렬'}) as HTMLSelectElement).value).toBe('views'));
    fireEvent.click(screen.getByRole('button',{name:'북마크',exact:true}));await waitFor(()=>expect((screen.getByRole('combobox',{name:'카탈로그 정렬'}) as HTMLSelectElement).value).toBe('latest'));
    expect(mocks.api.mock.calls.some(([path])=>path.includes('scope=bookmarked')&&path.includes('sort=latest'))).toBe(true);
  });
  it('uses a ready total without issuing the extra count request',async()=>{
    mocks.api.mockResolvedValueOnce({...page,countToken:null,totalCount:1,countStatus:'ready'});render(<Catalog active paused={false} backRef={{current:null}}/>);
    await screen.findByText('1',{selector:'.catalog-total'});expect(mocks.api.mock.calls.some(([path])=>path.includes('/count?'))).toBe(false);
  });
  it('distinguishes unpublished from a published empty search',async()=>{
    mocks.api.mockResolvedValueOnce({...page,ready:false,items:[],countToken:null});render(<Catalog active paused={false} backRef={{current:null}}/>);await screen.findByText('카탈로그가 아직 공유되지 않았습니다');
    mocks.api.mockResolvedValueOnce({...page,items:[],countToken:null,totalCount:0,countStatus:'ready'});fireEvent.click(screen.getByRole('button',{name:'카탈로그 새로고침'}));await screen.findByText('검색 결과가 없습니다');expect(screen.queryByText('카탈로그가 아직 공유되지 않았습니다')).toBeNull();
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
    mocks.api.mockImplementation(()=>new Promise(()=>{}));fireEvent.change(screen.getByRole('combobox',{name:'카탈로그 언어'}),{target:{value:'japanese'}});
    expect((screen.getByText('밤의 도서관').closest('button') as HTMLButtonElement).disabled).toBe(true);
    fireEvent.click(screen.getByText('밤의 도서관'));expect(screen.queryByText('상세 정보')).toBeNull();
  });
});
