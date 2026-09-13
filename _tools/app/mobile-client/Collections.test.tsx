import {act, cleanup, fireEvent, render, screen, waitFor, within} from '@testing-library/react';
import {afterEach, beforeEach, describe, expect, it, vi} from 'vitest';
import {collectionCardCredit, collectionCardDate, collectionPath, editionVolumes, editions} from './collectionModel';
import type {CollectionDetail, CollectionPage} from './collectionModel';
const mocks=vi.hoisted(()=>({api:vi.fn(),native:vi.fn()}));
vi.mock('./transport',()=>({api:mocks.api,native:mocks.native,errorText:(reason:unknown)=>String(reason)}));
vi.mock('./media',()=>({mediaTicket:vi.fn()}));
import {Collections} from './Collections';
const item:CollectionDetail={id:'manga-1',name:'밤의 도서관',type:'manga',showcase:true,selectedWorkArtworkId:'cover',volumes:[{id:'v2',volumeNumber:2,editionIndex:0,displayLabel:'2권',coverArtworkId:'c2'},{id:'e1',volumeNumber:1,editionIndex:1,displayLabel:'특별판 1권',coverArtworkId:'e1'},{id:'v1',volumeNumber:1,editionIndex:0,displayLabel:'1',coverArtworkId:'c1'}],artworks:[]};
const page:CollectionPage={ready:true,filterVersion:1,revision:'r1',publishedAt:null,items:[item],nextCursor:null};
beforeEach(()=>{mocks.api.mockReset();mocks.native.mockReset();mocks.api.mockImplementation(async(path:string)=>path.includes('/v1/collections/')?{revision:'r1',item}:page);mocks.native.mockResolvedValue({url:'https://example.invalid/cover',expires_in:300});});
afterEach(cleanup);
describe('read-only collections',()=>{
  it('filters the server list, resets pagination and retains per-type choices outside Showcase',async()=>{
    mocks.api.mockResolvedValue({...page,nextCursor:'page-2'});
    render(<Collections active paused={false} backRef={{current:null}}/>);await screen.findByText('밤의 도서관');
    fireEvent.click(screen.getByRole('button',{name:'다음'}));
    await waitFor(()=>expect(mocks.api.mock.calls.at(-1)?.[0]).toContain('cursor=page-2'));
    fireEvent.change(screen.getByRole('slider',{name:'내 별점'}),{target:{value:'4.5'}});
    await waitFor(()=>expect(mocks.api.mock.calls.at(-1)?.[0]).toContain('rating=4.5'));
    expect(mocks.api.mock.calls.at(-1)?.[0]).not.toContain('cursor=');
    fireEvent.change(screen.getByRole('combobox',{name:'컬렉션 정렬'}),{target:{value:'recent'}});
    await waitFor(()=>expect(mocks.api.mock.calls.at(-1)?.[0]).toContain('sort=recent'));
    fireEvent.click(screen.getByRole('button',{name:'정렬 방향'}));
    await waitFor(()=>expect(mocks.api.mock.calls.at(-1)?.[0]).toContain('direction=asc'));
    fireEvent.click(screen.getByRole('button',{name:'쇼케이스'}));
    await waitFor(()=>expect(mocks.api.mock.calls.at(-1)?.[0]).toContain('showcase=true'));
    expect(mocks.api.mock.calls.at(-1)?.[0]).not.toMatch(/rating=|sort=/);
    expect(screen.queryByRole('slider')).toBeNull();
    fireEvent.click(screen.getByRole('button',{name:'라이브러리'}));
    expect(screen.getByRole('slider').getAttribute('aria-valuetext')).toBe('4.5점');
    fireEvent.click(screen.getByRole('button',{name:'만화'}));
    expect(screen.getByRole('slider').getAttribute('aria-valuetext')).toBe('전체');
    fireEvent.click(screen.getByRole('button',{name:'게임'}));
    expect(screen.getByRole('slider').getAttribute('aria-valuetext')).toBe('4.5점');
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
    mocks.api.mockResolvedValueOnce({...page,ready:false,items:[]});const backRef={current:null};const view=render(<Collections active paused={false} backRef={backRef}/>);await screen.findByText('컬렉션이 아직 공유되지 않았습니다');
    mocks.api.mockResolvedValueOnce({...page,items:[]});fireEvent.click(screen.getByRole('button',{name:'새로고침'}));await screen.findByText('아직 컬렉션이 없습니다');
    mocks.api.mockRejectedValueOnce(Object.assign(new Error('요청한 정보를 찾을 수 없습니다.'),{status:404}));fireEvent.click(screen.getByRole('button',{name:'새로고침'}));await screen.findByText(/서버에 모바일 컬렉션 기능이 필요/);view.unmount();
  });
  it('keeps the current selection and reloads repeated searches',async()=>{
    render(<Collections active paused={false} backRef={{current:null}}/>);await screen.findByText('밤의 도서관');
    fireEvent.click(screen.getByRole('button',{name:'게임',exact:true}));expect(screen.getByText('밤의 도서관')).toBeTruthy();
    fireEvent.click(screen.getByRole('button',{name:'라이브러리',exact:true}));expect(screen.getByText('밤의 도서관')).toBeTruthy();
    fireEvent.click(screen.getByRole('button',{name:'검색',exact:true}));await screen.findByText('밤의 도서관');expect(mocks.api.mock.calls.filter(([path])=>path.startsWith('/v1/collections?'))).toHaveLength(2);
  });
  it('ignores stale type results after a newer selection',async()=>{
    let resolveOld!:(value:CollectionPage)=>void;mocks.api.mockImplementationOnce(()=>new Promise(resolve=>{resolveOld=resolve;}));
    render(<Collections active paused={false} backRef={{current:null}}/>);fireEvent.click(screen.getByRole('button',{name:'만화',exact:true}));await screen.findByText('밤의 도서관');
    await act(async()=>resolveOld({...page,items:[{...item,id:'stale',name:'오래된 게임'}]}));expect(screen.queryByText('오래된 게임')).toBeNull();
  });
  it('opens ordered edition covers, requests only the opened original, and backs out one level',async()=>{
    const backRef:{current:(()=>boolean)|null}={current:null};render(<Collections active paused={false} backRef={backRef}/>);
    fireEvent.click(await screen.findByText('밤의 도서관'));await screen.findByRole('combobox',{name:'판본'});
    expect(within(screen.getByRole('region',{name:'권별 표지'})).getAllByRole('button').map(el=>el.lastElementChild?.textContent)).toEqual(['1권','2권']);
    expect(mocks.native.mock.calls.some(([,payload])=>payload.variant==='original')).toBe(false);
    fireEvent.click(screen.getByText('1권'));await screen.findByRole('dialog');await waitFor(()=>expect(mocks.native).toHaveBeenCalledWith('collectionArtwork',expect.objectContaining({artworkId:'c1',variant:'original',revision:'r1'}),expect.any(AbortSignal)));
    expect(within(screen.getByRole('dialog')).getAllByText('1권')).toHaveLength(1);
    expect(within(screen.getByRole('dialog')).queryByText('표지')).toBeNull();
    act(()=>{expect(backRef.current?.()).toBe(true);});expect(screen.queryByRole('dialog')).toBeNull();expect(screen.getByRole('combobox',{name:'판본'})).toBeTruthy();
    fireEvent.change(screen.getByRole('combobox',{name:'판본'}),{target:{value:'1'}});expect(screen.queryByText('2권')).toBeNull();expect(screen.getByText('특별판 1권')).toBeTruthy();
    act(()=>{expect(backRef.current?.()).toBe(true);});expect(screen.queryByRole('combobox',{name:'판본'})).toBeNull();expect(mocks.api.mock.calls.every(([, ,body])=>body===undefined)).toBe(true);
    expect(screen.queryByRole('button',{name:/편집|삭제|가져오기|게시/})).toBeNull();
  });
});

it('shows personal and provider metadata, hides manga imported descriptions, and renders TV seasons',async()=>{
 const manga={...item,author:'작가 이름',year:2020,myScore:4.5,genres:'모험',overview:'English provider overview'};
 mocks.api.mockImplementation(async(path:string)=>path.includes('?')?{...page,items:[manga]}:{revision:'r1',item:manga});
 const view=render(<Collections active paused={false} backRef={{current:null}}/>);fireEvent.click(await screen.findByText(item.name));
 await screen.findAllByText('★ 4.5 / 5');expect(screen.queryByText('English provider overview')).toBeNull();expect(screen.getAllByText('모험').length).toBeGreaterThan(0);view.unmount();
 const movie={...item,type:'movie',productionCompany:'제작사 이름',externalScore:85,series:{status:'방영 종료',cast:['출연자'],seasons:[{id:10,seasonNumber:1,name:'시즌 1',airDate:'2020-01-01',posterArtworkId:null,episodes:[{id:20,episodeNumber:1,name:'첫 회',airDate:'2020-01-01',runtimeMinutes:24}]}]}};
 mocks.api.mockImplementation(async(path:string)=>path.includes('?')?{...page,items:[movie]}:{revision:'r1',item:movie});
 render(<Collections active paused={false} backRef={{current:null}}/>);fireEvent.click(await screen.findByText(item.name));await screen.findByText('첫 회');expect(screen.getAllByText('제작사 이름').length).toBeGreaterThan(0);expect(screen.getByText('2020-01-01 · 24분')).toBeTruthy();
});

it('uses production company and TV date range for movie grid captions',()=>{
  const movie={...item,type:'movie' as const,productionCompany:'Studio',director:'Director',year:2016,seasonDateRange:['2016-01-14','2024-05-05']};
  expect(collectionCardCredit(movie)).toBe('Studio');expect(collectionCardDate(movie)).toBe('16.1.14~24.5.5');expect(collectionCardDate({...movie,seasonDateRange:null})).toBe('2016');
});
it('shows the full filtered Collection count instead of the loaded page length',async()=>{
  mocks.api.mockResolvedValue({...page,totalCount:125});render(<Collections active paused={false} backRef={{current:null}}/>);expect((await screen.findByLabelText('필터 결과 개수')).textContent).toBe('125개');
});
