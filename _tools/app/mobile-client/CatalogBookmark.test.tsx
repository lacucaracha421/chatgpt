import {afterEach,beforeEach,describe,it,expect,vi} from 'vitest';
import {outboxKey,setOutboxConnection} from './outboxConnection';
const CONNECTION='https://a.example';
import {act,cleanup,fireEvent,render,screen,waitFor} from '@testing-library/react';
import {Catalog} from './Catalog';
import type {CatalogItem,CatalogPage} from './catalogModel';

const mocks=vi.hoisted(()=>({api:vi.fn(),native:vi.fn(),decode:vi.fn()}));
vi.mock('./media',()=>({decodeImage:mocks.decode}));
vi.mock('./transport',()=>({api:mocks.api,native:mocks.native,errorText:(e:Error)=>e.message}));

const LIBRARY='a'.repeat(32);
const item:CatalogItem={provider:'kHentai',providerWorkId:'42',groupId:'group',title:'밤의 도서관',titleJpn:null,thumbnailUrl:null,artists:['작가'],series:[],fileCount:40,views:1200,posted:1000,bookmarked:false,versionCount:2,hasBookmarkedVersion:false};
const page:CatalogPage={ready:true,publicationRevision:'p1',publishedAt:null,items:[item],nextCursor:null,context:'context',countToken:null,totalCount:1,countStatus:'ready'};
const detail={...item,tagGroups:[],uploader:null,category:1,updated:null,fileSize:null,rating:null,bookmarkRevision:0};

/** A server that owns the domain, advertises the write capability, and accepts commands. */
function status(write=true,cursor=0){
  return {ready:true,publicationRevision:'p1',authorityLibraryId:write?LIBRARY:null,authorityEpoch:write?1:null,authorityContractVersion:write?1:null,authorityCursor:write?cursor:null,capabilities:{providers:['kHentai'],read:true,bookmarkWrite:write,refreshRequest:false}};
}
const accepted={libraryId:LIBRARY,epoch:1,contractVersion:1,provider:'kHentai',providerWorkId:'42',desiredState:true,entityRevision:1,changed:true};

beforeEach(()=>{setOutboxConnection(CONNECTION);
  localStorage.clear();mocks.api.mockReset();mocks.native.mockReset();mocks.decode.mockReset();
  mocks.decode.mockResolvedValue({naturalWidth:600,naturalHeight:900});
  mocks.native.mockImplementation(async(operation:string,payload:Record<string,unknown>)=>{
    if(operation==='api'&&payload.path==='/v1/mobile-catalog/status')return status();
    if(operation==='bookmarkCommand')return accepted;
    return {url:'data:image/gif;base64,R0lGODlhAQABAAAAACw='};
  });
  mocks.api.mockImplementation(async(path:string)=>{
    if(path.includes('/status'))return status();
    if(path.includes('/works/'))return {publicationRevision:'p1',item:detail};
    if(path.includes('/editions?'))return {publicationRevision:'p1',groupId:'group',selectedProviderWorkId:null,items:[],nextCursor:null,totalCount:0};
    return page;
  });
});
afterEach(cleanup);

async function openDetail(){
  render(<Catalog active paused={false} backRef={{current:null}}/>);
  fireEvent.click(await screen.findByText('밤의 도서관'));
  await screen.findByRole('button',{name:'북마크'});
}

describe('catalog bookmark toggle',()=>{
  it('offers a write only when the server advertises the capability',async()=>{
    await openDetail();
    fireEvent.click(screen.getByRole('button',{name:'북마크'}));
    await waitFor(()=>expect(mocks.native.mock.calls.filter(([operation])=>operation==='bookmarkCommand')).toHaveLength(1));
    // The visible state follows the intent at once, then settles as confirmed.
    await waitFor(()=>expect(screen.getByRole('button',{name:'북마크 해제'})).toBeTruthy());
    expect(screen.queryByText('저장 대기')).toBeNull();
  });

  it('keeps the same bookmark control, status line and detail while pending and after saving',async()=>{
    let finish!:(value:unknown)=>void;
    mocks.native.mockImplementation(async(operation:string,payload:Record<string,unknown>)=>{
      if(operation==='api'&&payload.path==='/v1/mobile-catalog/status')return status();
      if(operation==='bookmarkCommand')return new Promise(resolve=>{finish=resolve;});
      return {url:'data:image/gif;base64,R0lGODlhAQABAAAAACw='};
    });
    await openDetail();
    const button=screen.getByRole('button',{name:'북마크'});
    const row=button.parentElement!,line=row.nextElementSibling!;
    const detailReads=()=>mocks.api.mock.calls.filter(([path])=>String(path).includes('/works/')).length;
    await waitFor(()=>expect(mocks.api.mock.calls.some(([path])=>String(path).includes('/reader'))).toBe(true));
    const reads=detailReads();
    expect(line.className).toContain('catalog-bookmark-state');expect(line.textContent).toBe('');
    fireEvent.click(button);
    // Pending: the same elements, only their text changes; the status line was already there.
    await waitFor(()=>expect(line.textContent).toBe('저장 대기'));
    expect(screen.getByRole('button',{name:'북마크 저장 중'})).toBe(button);
    expect(row.nextElementSibling).toBe(line);expect(button.querySelector('.catalog-bookmark-label')?.textContent).toBe('북마크됨');
    await act(async()=>finish(accepted));
    await waitFor(()=>expect(screen.getByRole('button',{name:'북마크 해제'})).toBe(button));
    expect(row.nextElementSibling).toBe(line);expect(line.textContent).toBe('');
    // The toggle does not re-run the detail load under the open page.
    expect(detailReads()).toBe(reads);
  });

  it('keeps the bookmark action beside reader and marks bookmarked covers',async()=>{
    const bookmarked={...item,bookmarked:true,hasBookmarkedVersion:true};
    mocks.api.mockImplementation(async(path:string)=>{
      if(path.includes('/status'))return status();
      if(path.includes('/works/'))return {publicationRevision:'p1',item:{...detail,bookmarked:true,bookmarkRevision:1}};
      if(path.includes('/editions?'))return {publicationRevision:'p1',groupId:'group',selectedProviderWorkId:null,items:[],nextCursor:null,totalCount:0};
      return {...page,items:[bookmarked]};
    });
    render(<Catalog active paused={false} backRef={{current:null}}/>);
    await screen.findByText('밤의 도서관');
    const coverMark=document.querySelector('.catalog-saved');
    expect(coverMark?.getAttribute('aria-label')).toBe('북마크됨');
    fireEvent.click(screen.getByText('밤의 도서관'));
    const read=await screen.findByRole('button',{name:'읽기'});
    const bookmark=await screen.findByRole('button',{name:'북마크 해제'});
    const actions=read.closest('.catalog-primary-actions');
    expect(actions).toBeTruthy();
    expect(actions?.contains(bookmark)).toBe(true);
  });

  it('projects a pending bookmark into the edition row and cover before confirmation',async()=>{
    const reply=Promise.withResolvers<unknown>();
    mocks.native.mockImplementation(async(operation:string,payload:Record<string,unknown>)=>{
      if(operation==='api'&&payload.path==='/v1/mobile-catalog/status')return status();
      if(operation==='bookmarkCommand')return reply.promise;
      return {url:'data:image/gif;base64,R0lGODlhAQABAAAAACw='};
    });
    mocks.api.mockImplementation(async(path:string)=>{
      if(path.includes('/status'))return status();
      if(path.includes('/works/'))return {publicationRevision:'p1',item:detail};
      if(path.includes('/editions?'))return {publicationRevision:'p1',groupId:'group',selectedProviderWorkId:null,items:[item],nextCursor:null,totalCount:1};
      return page;
    });
    render(<Catalog active paused={false} backRef={{current:null}}/>);
    fireEvent.click(await screen.findByText('밤의 도서관'));
    await screen.findByRole('region',{name:'카탈로그 판본'});
    fireEvent.click(await screen.findByRole('button',{name:'북마크'}));
    expect(await screen.findByLabelText('40p · 북마크 · 저장 대기')).toBeTruthy();
    fireEvent.click(screen.getByRole('button',{name:'카탈로그 목록으로'}));
    expect(document.querySelector('.catalog-saved')).toBeTruthy();
    await act(async()=>reply.resolve(accepted));
    await waitFor(()=>expect(localStorage.getItem(outboxKey('lakomics.catalog.bookmarks.outbox.v1')!)).toBe('{}'));
    expect(document.querySelector('.catalog-saved')).toBeTruthy();
  });

  it('keeps each edition card on one line with the same elements from pending to saved',async()=>{
    const reply=Promise.withResolvers<unknown>();
    mocks.native.mockImplementation(async(operation:string,payload:Record<string,unknown>)=>{
      if(operation==='api'&&payload.path==='/v1/mobile-catalog/status')return status();
      if(operation==='bookmarkCommand')return reply.promise;
      return {url:'data:image/gif;base64,R0lGODlhAQABAAAAACw='};
    });
    mocks.api.mockImplementation(async(path:string)=>{
      if(path.includes('/status'))return status();
      if(path.includes('/works/'))return {publicationRevision:'p1',item:detail};
      if(path.includes('/editions?'))return {publicationRevision:'p1',groupId:'group',selectedProviderWorkId:null,items:[item],nextCursor:null,totalCount:1};
      return page;
    });
    render(<Catalog active paused={false} backRef={{current:null}}/>);
    fireEvent.click(await screen.findByText('밤의 도서관'));
    const meta=await screen.findByLabelText('40p');
    const mark=meta.querySelector('.catalog-edition-mark')!,text=meta.textContent;
    fireEvent.click(await screen.findByRole('button',{name:'북마크'}));
    expect(await screen.findByLabelText('40p · 북마크 · 저장 대기')).toBe(meta);
    expect(meta.textContent).toBe(text);expect(meta.querySelector('.catalog-edition-mark')).toBe(mark);
    await act(async()=>reply.resolve(accepted));
    expect(await screen.findByLabelText('40p · 북마크')).toBe(meta);
    // Only the mark lights up; the visible text and the element count never change.
    expect(meta.textContent).toBe(text);expect(meta.childElementCount).toBe(2);expect(mark.classList.contains('is-on')).toBe(true);
  });

  it('projects a pending removal out of a single-version edition and cover',async()=>{
    const reply=Promise.withResolvers<unknown>();
    const saved={...item,bookmarked:true,hasBookmarkedVersion:true,versionCount:1};
    const savedDetail={...detail,bookmarked:true,hasBookmarkedVersion:true,versionCount:1,bookmarkRevision:1};
    mocks.native.mockImplementation(async(operation:string,payload:Record<string,unknown>)=>{
      if(operation==='api'&&payload.path==='/v1/mobile-catalog/status')return status();
      if(operation==='bookmarkCommand')return reply.promise;
      return {url:'data:image/gif;base64,R0lGODlhAQABAAAAACw='};
    });
    mocks.api.mockImplementation(async(path:string)=>{
      if(path.includes('/status'))return status();
      if(path.includes('/works/'))return {publicationRevision:'p1',item:savedDetail};
      if(path.includes('/editions?'))return {publicationRevision:'p1',groupId:'group',selectedProviderWorkId:null,items:[saved],nextCursor:null,totalCount:1};
      return {...page,items:[saved]};
    });
    render(<Catalog active paused={false} backRef={{current:null}}/>);
    fireEvent.click(await screen.findByText('밤의 도서관'));
    await screen.findByLabelText('40p · 북마크');
    fireEvent.click(await screen.findByRole('button',{name:'북마크 해제'}));
    await waitFor(()=>expect(screen.queryByLabelText('40p · 북마크')).toBeNull());
    fireEvent.click(screen.getByRole('button',{name:'카탈로그 목록으로'}));
    expect(document.querySelector('.catalog-saved')).toBeNull();
    await act(async()=>reply.resolve({...accepted,desiredState:false,entityRevision:2}));
    await waitFor(()=>expect(localStorage.getItem(outboxKey('lakomics.catalog.bookmarks.outbox.v1')!)).toBe('{}'));
    expect(document.querySelector('.catalog-saved')).toBeNull();
  });

  it('refreshes an open detail when the authority cursor advances without a new publication',async()=>{
    let cursor=0,remote=false;
    mocks.api.mockImplementation(async(path:string)=>{
      if(path.includes('/status'))return status(true,cursor);
      if(path.includes('/works/'))return {publicationRevision:'p1',item:{...detail,bookmarked:remote,bookmarkRevision:cursor}};
      if(path.includes('/editions?'))return {publicationRevision:'p1',groupId:'group',selectedProviderWorkId:null,items:[{...item,bookmarked:remote}],nextCursor:null,totalCount:1};
      return {...page,items:[{...item,bookmarked:remote,hasBookmarkedVersion:remote}]};
    });
    render(<Catalog active paused={false} backRef={{current:null}}/>);
    fireEvent.click(await screen.findByText('밤의 도서관'));
    expect(await screen.findByRole('button',{name:'북마크'})).toBeTruthy();

    cursor=1;remote=true;
    act(()=>window.dispatchEvent(new Event('lakomics-resume')));

    await waitFor(()=>expect(screen.getByRole('button',{name:'북마크 해제'})).toBeTruthy());
  });

  it('does not offer a write while the capability is unadvertised',async()=>{
    mocks.api.mockImplementation(async(path:string)=>{
      if(path.includes('/status'))return status(false);
      if(path.includes('/works/'))return {publicationRevision:'p1',item:detail};
      if(path.includes('/editions?'))return {publicationRevision:'p1',groupId:'group',selectedProviderWorkId:null,items:[],nextCursor:null,totalCount:0};
      return page;
    });
    await openDetail();
    const toggle=screen.getByRole('button',{name:'북마크'}) as HTMLButtonElement;
    expect(toggle.disabled).toBe(true);
    fireEvent.click(toggle);
    // Nothing durable is created by a click the authority cannot accept.
    expect(mocks.native.mock.calls.filter(([operation])=>operation==='bookmarkCommand')).toHaveLength(0);
    expect(localStorage.getItem(outboxKey('lakomics.catalog.bookmarks.outbox.v1')!)??'').not.toContain('operationId');
  });

  it('marks the write pending until the authority confirms it',async()=>{
    const reply=Promise.withResolvers<unknown>();
    mocks.native.mockImplementation(async(operation:string,payload:Record<string,unknown>)=>{
      if(operation==='api'&&payload.path==='/v1/mobile-catalog/status')return status();
      if(operation==='bookmarkCommand')return reply.promise;
      return {url:'data:image/gif;base64,R0lGODlhAQABAAAAACw='};
    });
    await openDetail();
    fireEvent.click(screen.getByRole('button',{name:'북마크'}));
    // The durable intent commits before the round trip, so the state is marked
    // pending rather than claimed as accepted.
    const pending=await screen.findByRole('button',{name:'북마크 저장 중'});
    expect((pending as HTMLButtonElement).getAttribute('aria-pressed')).toBe('true');
    expect(screen.getByText('저장 대기')).toBeTruthy();
    expect(localStorage.getItem(outboxKey('lakomics.catalog.bookmarks.outbox.v1')!)).toContain('operationId');
    await act(async()=>reply.resolve(accepted));
    await waitFor(()=>expect(screen.getByRole('button',{name:'북마크 해제'})).toBeTruthy());
    expect(screen.queryByText('저장 대기')).toBeNull();
    expect(localStorage.getItem(outboxKey('lakomics.catalog.bookmarks.outbox.v1')!)).toBe('{}');
  });

  it('keeps the intent and reports it when the server rejects the write',async()=>{
    mocks.native.mockImplementation(async(operation:string,payload:Record<string,unknown>)=>{
      if(operation==='api'&&payload.path==='/v1/mobile-catalog/status')return status();
      if(operation==='bookmarkCommand')throw new Error('인증에 실패했습니다. 토큰을 확인해 주세요.');
      return {url:'data:image/gif;base64,R0lGODlhAQABAAAAACw='};
    });
    await openDetail();
    fireEvent.click(screen.getByRole('button',{name:'북마크'}));
    const failure=await screen.findByText(/인증에 실패했습니다/);
    expect(failure.getAttribute('role')).toBe('alert');
    // The user's decision is not silently lost.
    await waitFor(()=>expect(screen.getByRole('button',{name:'북마크 저장 중'})).toBeTruthy());
    expect(localStorage.getItem(outboxKey('lakomics.catalog.bookmarks.outbox.v1')!)).toContain('operationId');
  });

  it('survives a restart with the pending write intact',async()=>{
    localStorage.setItem(outboxKey('lakomics.catalog.bookmarks.outbox.v1')!,JSON.stringify({'kHentai:42':{provider:'kHentai',providerWorkId:'42',desired:true,operationId:'11111111-1111-4111-8111-111111111111',baseRevision:0,epoch:1,libraryId:LIBRARY,createdAt:1}}));
    render(<Catalog active paused={false} backRef={{current:null}}/>);
    fireEvent.click(await screen.findByText('밤의 도서관'));
    // A fresh mount re-reads the durable intent rather than a memory-only copy.
    const pending=await screen.findByRole('button',{name:'북마크 저장 중'});
    expect(pending.getAttribute('aria-pressed')).toBe('true');
  });
});
