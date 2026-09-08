import {afterEach,beforeEach,describe,it,expect,vi} from 'vitest';
import {act,cleanup,fireEvent,render,screen,waitFor} from '@testing-library/react';
import {Catalog} from './Catalog';
import type {CatalogItem,CatalogPage} from './catalogModel';
const mocks=vi.hoisted(()=>({api:vi.fn()}));
vi.mock('./transport',()=>({api:mocks.api,errorText:(e:Error)=>e.message}));
const item:CatalogItem={provider:'kHentai',providerWorkId:'42',groupId:'group',title:'밤의 도서관',titleJpn:null,thumbnailUrl:null,artists:['작가'],series:[],fileCount:40,views:1200,posted:1000,bookmarked:true,versionCount:2,hasBookmarkedVersion:true};
const page:CatalogPage={ready:true,publicationRevision:'p1',publishedAt:null,items:[item],nextCursor:null,context:'context',countToken:'count',totalCount:null,countStatus:'pending'};
beforeEach(()=>{mocks.api.mockReset();mocks.api.mockImplementation(async(path:string)=>{
  if(path.includes('/count?'))return {publicationRevision:'p1',totalCount:1};
  if(path.includes('/works/'))return {publicationRevision:'p1',item:{...item,tagGroups:[{namespace:'artist',values:['작가']}],uploader:null,category:1,updated:null,fileSize:null,rating:null}};
  if(path.includes('/editions?'))return {publicationRevision:'p1',groupId:'group',selectedProviderWorkId:null,items:[item],nextCursor:null,totalCount:1};
  return page;
});});
afterEach(cleanup);
describe('mobile catalog reads',()=>{
  it('delivers a usable page while count is pending and keeps it on count failure',async()=>{
    let reject!:(e:Error)=>void;mocks.api.mockImplementation(path=>path.includes('/count?')?new Promise((_,r)=>{reject=r;}):Promise.resolve(page));
    render(<Catalog active paused={false} backRef={{current:null}}/>);await screen.findByText('밤의 도서관');expect(screen.getByText('개수 확인 중')).toBeTruthy();
    await act(async()=>reject(new Error('count unavailable')));expect(screen.getByText('밤의 도서관')).toBeTruthy();expect(screen.queryByText('0개')).toBeNull();await screen.findByText('개수를 확인하지 못했습니다.');
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
    await screen.findByText('1개');expect(mocks.api.mock.calls.filter(([p])=>p.includes('/search?'))).toHaveLength(1);
  });
  it('disables retained cards while a replacement query is pending',async()=>{
    render(<Catalog active paused={false} backRef={{current:null}}/>);await screen.findByText('밤의 도서관');await screen.findByText('1개');
    mocks.api.mockImplementation(()=>new Promise(()=>{}));fireEvent.change(screen.getByRole('combobox',{name:'카탈로그 언어'}),{target:{value:'japanese'}});
    expect((screen.getByText('밤의 도서관').closest('button') as HTMLButtonElement).disabled).toBe(true);
    fireEvent.click(screen.getByText('밤의 도서관'));expect(screen.queryByText('상세 정보')).toBeNull();
  });
});
