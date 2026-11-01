import {act,cleanup,fireEvent,screen,waitFor,within} from '@testing-library/react';
import {afterEach,beforeEach,expect,it,vi} from 'vitest';
import {render,openScreenSearch} from './screenSearchTest';
import {Somi} from './Somi';
import {Catalog} from './Catalog';
import type {SomiPost,SomiStatus} from '../src/library/types';

const mocks=vi.hoisted(()=>({native:vi.fn(),api:vi.fn()}));
vi.mock('./transport',()=>({native:mocks.native,api:mocks.api,errorText:(e:Error)=>e.message}));
vi.mock('./media',()=>({decodeImage:async()=>({naturalWidth:600,naturalHeight:900})}));
const post:SomiPost={id:'aaaaaaaaaaaaaaaaaaaaab',title:'소미의 책',writerHandle:'writer',writerName:'작가',seconds:1792422015,nanos:0,votes:4,views:20,comments:2,coverKey:'',cover:null,pages:null,bookmarked:false};
const loggedIn:SomiStatus={loggedIn:true,handle:'reader',displayName:'독자',collected:1,total:1,complete:true,syncing:false};
let status=loggedIn,bookmarked=false;
const props={active:true,paused:false,backRef:{current:null},onSourceChange:vi.fn()};
beforeEach(()=>{
  localStorage.clear();status={...loggedIn};bookmarked=false;mocks.native.mockReset();mocks.api.mockReset();
  mocks.native.mockImplementation(async(op:string,p:Record<string,unknown>)=>{
    if(op==='somiStatus')return status;
    if(op==='somiSearch')return {items:[{...post,bookmarked}],total:1};
    if(op==='somiBookmark'){bookmarked=!bookmarked;return {bookmarked};}
    if(op==='somiFillCovers')return [];
    return {};
  });
});
afterEach(()=>{cleanup();vi.restoreAllMocks();vi.unstubAllGlobals();});
const requests=(op:string)=>mocks.native.mock.calls.filter(([name])=>name===op);

it('shows the login empty state and launches login without searching or opening a post',async()=>{
  status={...loggedIn,loggedIn:false,handle:null,displayName:null};render(<Somi {...props}/>);
  fireEvent.click(await screen.findByRole('button',{name:'코네 로그인'}));
  expect(requests('somiLogin')).toHaveLength(1);expect(requests('somiSearch')).toHaveLength(0);expect(requests('somiOpen')).toHaveLength(0);
});

it('shows the locally indexed title and writer',async()=>{
  render(<Somi {...props}/>);await screen.findByText(post.title);expect(screen.getByText('작가')).toBeTruthy();expect(requests('somiOpen')).toHaveLength(0);
});

it('a period selects votes, then allows a different sort',async()=>{
  render(<Somi {...props}/>);await screen.findByText(post.title);fireEvent.click(screen.getByRole('button',{name:'보기'}));
  fireEvent.click(screen.getByRole('radio',{name:'1개월'}));
  await waitFor(()=>expect(requests('somiSearch').at(-1)?.[1]).toMatchObject({days:30,sort:'votes'}));
  expect(screen.getByRole('radio',{name:'추천순'}).getAttribute('aria-checked')).toBe('true');
  fireEvent.click(screen.getByRole('radio',{name:'조회순'}));
  await waitFor(()=>expect(requests('somiSearch').at(-1)?.[1]).toMatchObject({days:30,sort:'views'}));
});

it('fills missing covers in batches, so early covers do not wait for the whole page',async()=>{
  const posts=Array.from({length:7},(_,i)=>({...post,id:`aaaaaaaaaaaaaaaaaaaaa${i}`,title:`책 ${i}`,coverKey:'ab'.repeat(32)}));
  const batches:((covers:{id:string;cover:string}[])=>void)[]=[];
  mocks.native.mockImplementation(async(op:string)=>op==='somiStatus'?status:op==='somiSearch'?{items:posts,total:7}:op==='somiFillCovers'?new Promise(resolve=>batches.push(resolve)):{});
  render(<Somi {...props}/>);await screen.findByText('책 0');
  await waitFor(()=>expect(requests('somiFillCovers')).toHaveLength(1));
  expect((requests('somiFillCovers')[0][1] as {ids:string[]}).ids).toHaveLength(6);
  await act(async()=>batches[0]([]));
  await waitFor(()=>expect(requests('somiFillCovers')).toHaveLength(2));
  expect((requests('somiFillCovers')[1][1] as {ids:string[]}).ids).toEqual([posts[6].id]);
});

it('bookmark view uses added order, and card bookmarking never opens the post',async()=>{
  render(<Somi {...props} bookmarked/>);await screen.findByText(post.title);fireEvent.click(screen.getByRole('button',{name:'북마크',exact:true}));
  await waitFor(()=>expect(requests('somiBookmark')).toHaveLength(1));expect(requests('somiOpen')).toHaveLength(0);
  fireEvent.click(screen.getByRole('button',{name:'보기'}));
  expect(screen.queryByRole('radiogroup',{name:'소미 표시'})).toBeNull();
  await waitFor(()=>expect(requests('somiSearch').at(-1)?.[1]).toMatchObject({bookmarked:true,sort:'added'}));
  expect(screen.getByRole('radio',{name:'추가순'}).getAttribute('aria-checked')).toBe('true');
});

it('keeps the old list until the newest search completes and ignores an older reply',async()=>{
  render(<Somi {...props}/>);await screen.findByText(post.title);openScreenSearch();
  // The shared search opens Somi's immediate local field.
  await screen.findByRole('textbox',{name:'제목·작가 검색'});
  const pending=new Map<string,(v:unknown)=>void>();mocks.native.mockImplementation((op:string,p:Record<string,unknown>)=>op==='somiSearch'?new Promise(resolve=>pending.set(String(p.query),resolve)):Promise.resolve(status));
  const field=screen.getByRole('textbox',{name:'제목·작가 검색'});fireEvent.change(field,{target:{value:'먼저'}});fireEvent.change(field,{target:{value:'나중'}});
  expect(screen.getAllByText(post.title).length).toBeGreaterThan(0);
  await act(async()=>pending.get('나중')?.({items:[{...post,title:'마지막 결과'}],total:1}));await screen.findByText('마지막 결과');
  await act(async()=>pending.get('먼저')?.({items:[{...post,title:'뒤늦은 결과'}],total:1}));expect(screen.queryByText('뒤늦은 결과')).toBeNull();
});

it('exposes Somi in the existing catalog source switch',async()=>{
  mocks.api.mockResolvedValue({ready:false,capabilities:{displayPreferencesVersion:1}});
  render(<Catalog active paused={false} backRef={{current:null}} endpoint="https://example.test"/>);
  fireEvent.click(screen.getByRole('radio',{name:'소미',exact:true}));
  await screen.findByRole('region',{name:'소미'});await screen.findByText(post.title);
});

it('keeps 북마크 selected for Somi bookmarks, remembers the switch and reuses the catalog list',async()=>{
  const catalogItem={provider:'kHentai',providerWorkId:'42',groupId:'42',title:'카탈로그 북마크',artists:[],series:[],thumbnailUrl:null,fileCount:10,bookmarked:true};
  mocks.api.mockImplementation(async(path:string)=>path.includes('/status')?{publicationRevision:'p1',capabilities:{displayPreferencesVersion:1}}:{ready:true,publicationRevision:'p1',items:[catalogItem],nextCursor:null,totalCount:1,countStatus:'ready'});
  const view=render(<Catalog active paused={false} backRef={{current:null}}/>);
  await screen.findByText(catalogItem.title);
  fireEvent.click(within(screen.getByRole('radiogroup',{name:'카탈로그 출처'})).getByRole('radio',{name:'북마크'}));
  await waitFor(()=>expect(mocks.api.mock.calls.some(([path])=>path.includes('scope=bookmarked')&&path.includes('sort=bookmarkAdded')&&path.includes('language=korean'))).toBe(true));
  const card=screen.getByText(catalogItem.title),calls=mocks.api.mock.calls.filter(([path])=>path.includes('/search?')).length;
  let finish!:(value:unknown)=>void;const base=mocks.native.getMockImplementation()!;
  mocks.native.mockImplementation((op:string,p:Record<string,unknown>)=>op==='somiSearch'?new Promise(resolve=>{finish=resolve;}):base(op,p));
  fireEvent.click(within(screen.getByRole('radiogroup',{name:'북마크 출처'})).getByRole('radio',{name:'소미'}));
  await waitFor(()=>expect(requests('somiSearch').at(-1)?.[1]).toMatchObject({bookmarked:true,sort:'added'}));
  expect(card.closest('section')?.style.display).toBe('flex');
  await act(async()=>finish({items:[{...post,bookmarked:true}],total:1}));
  await screen.findByRole('region',{name:'소미'});
  expect(within(screen.getByRole('radiogroup',{name:'카탈로그 출처'})).getByRole('radio',{name:'북마크'}).getAttribute('aria-checked')).toBe('true');
  fireEvent.click(within(screen.getByRole('radiogroup',{name:'북마크 출처'})).getByRole('radio',{name:'카탈로그'}));
  await screen.findByRole('region',{name:'만화 카탈로그'});
  expect(screen.getByText(catalogItem.title)).toBe(card);
  expect(mocks.api.mock.calls.filter(([path])=>path.includes('/search?'))).toHaveLength(calls);
  fireEvent.click(within(screen.getByRole('radiogroup',{name:'북마크 출처'})).getByRole('radio',{name:'소미'}));
  await screen.findByRole('region',{name:'소미'});view.unmount();
  status={...loggedIn,loggedIn:false};
  render(<Catalog active paused={false} backRef={{current:null}}/>);
  await screen.findByText(catalogItem.title);
  fireEvent.click(within(screen.getByRole('radiogroup',{name:'카탈로그 출처'})).getByRole('radio',{name:'북마크'}));
  await screen.findByRole('button',{name:'코네 로그인'});
  expect(within(screen.getByRole('radiogroup',{name:'북마크 출처'})).getByRole('radio',{name:'소미'}).getAttribute('aria-checked')).toBe('true');
  fireEvent.click(within(screen.getByRole('radiogroup',{name:'북마크 출처'})).getByRole('radio',{name:'카탈로그'}));
  await screen.findByRole('region',{name:'만화 카탈로그'});
});

it('board has no display group or added sort and restores its own period and list',async()=>{
  const view=render(<Somi {...props}/>);await screen.findByText(post.title);
  fireEvent.click(screen.getByRole('button',{name:'보기'}));
  expect(screen.queryByText('표시')).toBeNull();expect(screen.queryByRole('radio',{name:'추가순'})).toBeNull();
  fireEvent.click(screen.getByRole('radio',{name:'1개월'}));fireEvent.click(screen.getByRole('radio',{name:'조회순'}));
  await waitFor(()=>expect(requests('somiSearch').at(-1)?.[1]).toMatchObject({bookmarked:false,days:30,sort:'views'}));
  fireEvent.click(within(screen.getByRole('dialog',{name:'소미 보기'})).getByRole('button',{name:'닫기'}));
  await waitFor(()=>expect(screen.getAllByText(post.title).length).toBeGreaterThan(0));
  const board=screen.getByRole('button',{name:new RegExp(post.title)});
  view.rerender(<Somi {...props} bookmarked/>);
  await waitFor(()=>expect(requests('somiSearch').at(-1)?.[1]).toMatchObject({bookmarked:true,days:null,sort:'added'}));
  await waitFor(()=>expect(screen.getByRole('button',{name:new RegExp(post.title)})).not.toBe(board));
  view.rerender(<Somi {...props}/>);
  expect(screen.getByRole('button',{name:new RegExp(post.title)})).toBe(board);
  fireEvent.click(screen.getByRole('button',{name:'보기'}));
  expect(screen.getByRole('radio',{name:'조회순'}).getAttribute('aria-checked')).toBe('true');
  expect(screen.getByRole('radio',{name:'1개월'}).getAttribute('aria-checked')).toBe('true');
});

it('ignores a bookmark reply after returning to the mounted board before it is ready',async()=>{
  const view=render(<Somi {...props}/>);
  const board=await screen.findByRole('button',{name:new RegExp(post.title)});
  const base=mocks.native.getMockImplementation()!;let finish!:(value:unknown)=>void;
  mocks.native.mockImplementation((op:string,p:Record<string,unknown>)=>op==='somiSearch'?new Promise(resolve=>{finish=resolve;}):base(op,p));
  view.rerender(<Somi {...props} bookmarked/>);
  await waitFor(()=>expect(requests('somiSearch').at(-1)?.[1]).toMatchObject({bookmarked:true,sort:'added'}));
  expect(board.disabled).toBe(true);
  view.rerender(<Somi {...props}/>);
  expect(board.disabled).toBe(false);
  await act(async()=>finish({items:[{...post,title:'늦은 북마크'}],total:1}));
  expect(screen.getByRole('button',{name:new RegExp(post.title)})).toBe(board);
  expect(screen.queryByText('늦은 북마크')).toBeNull();
});

it('retains the catalog while Somi prepares its first screen',async()=>{
  let ready!:(value:unknown)=>void;const base=mocks.native.getMockImplementation()!;
  mocks.native.mockImplementation((op:string,p:Record<string,unknown>)=>op==='somiStatus'?new Promise(resolve=>{ready=resolve;}):base(op,p));
  mocks.api.mockResolvedValue({ready:false,capabilities:{displayPreferencesVersion:1}});
  render(<Catalog active paused={false} backRef={{current:null}}/>);
  const catalog=screen.getByRole('region',{name:'만화 카탈로그'});
  fireEvent.click(screen.getByRole('radio',{name:'소미',exact:true}));
  await waitFor(()=>expect(ready).toBeTypeOf('function'));
  expect(catalog.style.display).toBe('flex');expect(screen.queryByRole('region',{name:'소미'})).toBeNull();
  await act(async()=>ready({...loggedIn,loggedIn:false}));
  await screen.findByRole('button',{name:'코네 로그인'});expect(catalog.style.display).toBe('none');
});

it('resumes the saved page and bookmarks in the reader without another article request',async()=>{
  vi.stubGlobal('innerWidth',800);vi.stubGlobal('innerHeight',1280);const base=mocks.native.getMockImplementation()!;
  mocks.native.mockImplementation((op:string,p:Record<string,unknown>)=>{
    if(op==='somiOpen')return Promise.resolve({title:post.title,writer:'작가',initialPage:4,manifest:{provider:'somi',providerWorkId:post.id,publicationRevision:'1',manifestExpiresAt:null,pages:Array.from({length:10},(_,index)=>({index,url:'',name:null,width:600,height:900,expiresAt:null}))}});
    if(op==='somiImage')return Promise.resolve({url:`https://app.lakomics.local/media-cache/somi-${p.index}`});
    return base(op,p);
  });
  render(<Somi {...props} bookmarked/>);fireEvent.click(await screen.findByRole('button',{name:new RegExp(post.title)}));
  const reader=await screen.findByRole('dialog',{name:'만화 읽기'});await within(reader).findByRole('img',{name:'4페이지'});
  expect(requests('somiOpen')).toHaveLength(1);expect(requests('somiPage')).toHaveLength(0);
  fireEvent.click(within(reader).getByRole('button',{name:'북마크'}));
  await waitFor(()=>expect(requests('somiBookmark')).toHaveLength(1));expect(requests('somiOpen')).toHaveLength(1);
  fireEvent.click(within(reader).getByRole('button',{name:'다음 페이지'}));
  await waitFor(()=>expect(requests('somiPage').at(-1)?.[1]).toMatchObject({id:post.id,page:5}));
});
