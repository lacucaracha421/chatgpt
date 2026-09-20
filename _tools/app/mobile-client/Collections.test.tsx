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
/** The portrait browsing row owns the type group and the tools next to it. */
const row=()=>screen.getByLabelText('컬렉션',{selector:'section'}).querySelector('.collection-toolbar') as HTMLElement;
const toolRow=()=>within(row()).getByRole('group',{name:'컬렉션 유형'}).nextElementSibling as HTMLElement;
const pressInRow=(name:string)=>fireEvent.click(within(row()).getByRole('button',{name}));
const pressTool=(name:string)=>fireEvent.click(within(toolRow()).getByRole('button',{name}));
/** The filter panel: the slider lives beside the compact select inside `.collection-controls`. */
const filterPanel=()=>screen.getAllByRole('group',{name:'별점 필터 범위'}).at(-1)!.closest('.collection-controls')!;
/** The transient panel below the browsing row, distinct from the drawer's own search form. */
const draft=()=>document.querySelector<HTMLInputElement>('.collection-tools-panel input[aria-label="컬렉션 검색"]')!;
const metadataBlock=()=>within(disclosure()).getByLabelText('작품 정보',{selector:'dl'});
/** jsdom renders `<details>` children regardless of state, so the open flag is the assertion. */
const disclosure=()=>screen.getByLabelText('컬렉션',{selector:'section'}).querySelector('details.collection-information') as HTMLDetailsElement;
beforeEach(()=>{mocks.api.mockReset();mocks.native.mockReset();mocks.api.mockImplementation(async(path:string)=>path.includes('/v1/collections/')?{revision:'r1',item}:page);mocks.native.mockResolvedValue({url:'https://example.invalid/cover',expires_in:300});});
afterEach(cleanup);
describe('read-only collections',()=>{
  it('filters the server list, resets pagination and retains per-type choices outside Showcase',async()=>{
    mocks.api.mockResolvedValue({...page,nextCursor:'page-2'});
    render(<Collections active paused={false} backRef={{current:null}}/>);await screen.findByText('밤의 도서관');
    pressTool('필터');
    fireEvent.click(screen.getByRole('button',{name:'다음'}));
    await waitFor(()=>expect(mocks.api.mock.calls.at(-1)?.[0]).toContain('cursor=page-2'));
    fireEvent.change(within(filterPanel()).getByRole('slider'),{target:{value:'4.5'}});
    await waitFor(()=>expect(mocks.api.mock.calls.at(-1)?.[0]).toContain('rating=4.5'));
    expect(mocks.api.mock.calls.at(-1)?.[0]).not.toContain('cursor=');
    fireEvent.change(within(filterPanel()).getByRole('combobox',{name:'컬렉션 정렬'}),{target:{value:'recent'}});
    await waitFor(()=>expect(mocks.api.mock.calls.at(-1)?.[0]).toContain('sort=recent'));
    fireEvent.click(within(filterPanel()).getByRole('button',{name:'정렬 방향'}));
    await waitFor(()=>expect(mocks.api.mock.calls.at(-1)?.[0]).toContain('direction=asc'));
    pressTool('쇼케이스 보기');
    await waitFor(()=>expect(mocks.api.mock.calls.at(-1)?.[0]).toContain('showcase=true'));
    expect(mocks.api.mock.calls.at(-1)?.[0]).not.toMatch(/rating=|sort=/);
    // Showcase has no rating filter, so its control leaves with the type row's state.
    expect(within(toolRow()).queryAllByRole('button',{name:'필터'})).toHaveLength(0);
    pressTool('쇼케이스 보기');
    expect(within(toolRow()).getByRole('button',{name:/필터|★ |미평가/})).toBeTruthy();
    expect(within(filterPanel()).getByRole('slider').getAttribute('aria-valuetext')).toBe('4.5점');
    pressInRow('만화');
    await waitFor(()=>expect(within(filterPanel()).getByRole('slider').getAttribute('aria-valuetext')).toBe('전체'));
    pressInRow('게임');
    await waitFor(()=>expect(within(filterPanel()).getByRole('slider').getAttribute('aria-valuetext')).toBe('4.5점'));
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
    mocks.api.mockResolvedValueOnce({...page,items:[]});fireEvent.click(screen.getByRole('button',{name:'새로고침'}));await screen.findByText('아직 컬렉션이 없습니다');
    mocks.api.mockRejectedValueOnce(Object.assign(new Error('요청한 정보를 찾을 수 없습니다.'),{status:404}));fireEvent.click(screen.getByRole('button',{name:'새로고침'}));await screen.findByText(/서버에 모바일 컬렉션 기능이 필요/);view.unmount();
  });
  it('re-reads the list for a submitted search and keeps Showcase state',async()=>{
    // The fixture answers every query with the same page, so the submitted query is the assertion.
    render(<Collections active paused={false} backRef={{current:null}}/>);await screen.findByText('밤의 도서관');
    pressInRow('게임');expect(screen.getByText('밤의 도서관')).toBeTruthy();
    expect(mocks.api.mock.calls.filter(([path])=>path.startsWith('/v1/collections?'))).toHaveLength(1);
    pressTool('쇼케이스 보기');
    await waitFor(()=>expect(mocks.api.mock.calls.at(-1)?.[0]).toContain('showcase=true'));
    pressTool('컬렉션 검색');
    fireEvent.change(draft(),{target:{value:'밤'}});
    fireEvent.submit(draft().closest('form')!);
    await waitFor(()=>expect(mocks.api.mock.calls.at(-1)?.[0]).toContain('q=%EB%B0%A4'));
    expect(mocks.api.mock.calls.at(-1)?.[0]).toContain('showcase=true');
  });
  it('ignores stale type results after a newer selection',async()=>{
    let resolveOld!:(value:CollectionPage)=>void;mocks.api.mockImplementationOnce(()=>new Promise(resolve=>{resolveOld=resolve;}));
    render(<Collections active paused={false} backRef={{current:null}}/>);
    pressInRow('만화');await screen.findByText('밤의 도서관');
    await act(async()=>resolveOld({...page,items:[{...item,id:'stale',name:'오래된 게임'}]}));expect(screen.queryByText('오래된 게임')).toBeNull();
  });
  it('keeps one compact control row, applies search only on submit, and closes transient surfaces',async()=>{
    const backRef:{current:(()=>boolean)|null}={current:null};render(<Collections active paused={false} backRef={backRef}/>);await screen.findByText('밤의 도서관');
    // One row carries the type choice, the Showcase switch and the two tools.
    expect(within(row()).getByRole('group',{name:'컬렉션 유형'}).textContent).toBe('게임만화영화');
    expect(within(row()).getAllByRole('button').map(button=>button.getAttribute('aria-label')||button.textContent)).toEqual(['게임','만화','영화','쇼케이스 보기','컬렉션 검색','필터']);
    // The drawer keeps its own copy for the portrait overlay and the landscape sidebar.
    expect(screen.getAllByRole('button',{name:'게임'})).toHaveLength(2);
    expect(screen.queryAllByRole('textbox',{name:'컬렉션 검색'})).toHaveLength(1);
    // Opening the draft and closing it must not apply anything.
    pressTool('컬렉션 검색');
    fireEvent.change(draft(),{target:{value:'밤'}});
    const before=mocks.api.mock.calls.length;
    pressTool('컬렉션 검색');
    expect(document.querySelectorAll('.collection-tools-panel input')).toHaveLength(0);
    expect(mocks.api.mock.calls).toHaveLength(before);
    // Submitting applies the query and surfaces the applied state with a clear action.
    expect(screen.queryAllByRole('textbox',{name:'컬렉션 검색'})).toHaveLength(1);
    pressTool('컬렉션 검색');
    expect(draft().value).toBe('');
    fireEvent.change(draft(),{target:{value:'밤'}});
    fireEvent.submit(draft().closest('form')!);
    await waitFor(()=>expect(mocks.api.mock.calls.at(-1)?.[0]).toContain('q='));
    // An applied query stays visible as state with its own clear action.
    expect(document.querySelector('.collection-tools-panel')).toBeNull();
    expect(within(row()).getByRole('button',{name:'컬렉션 검색'}).getAttribute('aria-pressed')).toBe('true');
    pressTool('컬렉션 검색');
    expect(document.querySelector('.collection-search input')?.value).toBe('밤');
    expect(screen.getByRole('button',{name:'‘밤’ 검색 지우기'})).toBeTruthy();
    pressTool('컬렉션 검색');
    fireEvent.keyDown(window,{key:'Escape'});
    expect(screen.getByRole('button',{name:'‘밤’ 검색 지우기'})).toBeTruthy();
    expect(screen.getByText('밤의 도서관')).toBeTruthy();
    expect(within(row()).getByRole('button',{name:'컬렉션 검색'}).getAttribute('aria-pressed')).toBe('true');
    // Clearing the applied query is explicit and restores the unfiltered list.
    pressTool('컬렉션 검색');
    fireEvent.click(screen.getByRole('button',{name:'‘밤’ 검색 지우기'}));
    await waitFor(()=>expect(document.querySelector('.collection-applied')).toBeNull());
    expect(mocks.api.mock.calls.filter(([path])=>path.startsWith('/v1/collections?')).at(-1)?.[0]).not.toContain('q=%EB%B0%A4');
  });
  it('closes a search draft on native Back without applying it and restores focus',async()=>{
    const backRef:{current:(()=>boolean)|null}={current:null};
    render(<Collections active paused={false} backRef={backRef}/>);await screen.findByText(item.name);
    const opener=within(row()).getByRole('button',{name:'컬렉션 검색'});
    opener.focus();fireEvent.click(opener);
    fireEvent.change(draft(),{target:{value:'discard me'}});
    const before=mocks.api.mock.calls.length;
    act(()=>{expect(backRef.current?.()).toBe(true);});
    expect(document.querySelector('.collection-tools-panel')).toBeNull();
    expect(mocks.api.mock.calls).toHaveLength(before);
    expect(document.activeElement).toBe(opener);
    fireEvent.click(opener);expect(draft().value).toBe('');
  });
  it('closes transient controls on Back before leaving the work, and keeps the detail pane control-free',async()=>{
    const backRef:{current:(()=>boolean)|null}={current:null};render(<Collections active paused={false} backRef={backRef}/>);await screen.findByText('밤의 도서관');
    // The work pane opens without any browsing control or applied query left behind.
    pressTool('컬렉션 검색');
    fireEvent.change(draft(),{target:{value:'밤'}});
    fireEvent.submit(draft().closest('form')!);
    await waitFor(()=>expect(mocks.api.mock.calls.at(-1)?.[0]).toContain('q='));
    fireEvent.click(screen.getByText('밤의 도서관'));
    await waitFor(()=>expect(document.querySelector('.collection-detail h1')?.textContent).toBe('밤의 도서관'));
    expect(document.querySelector('.collection-toolbar')).toBeNull();
    expect(document.querySelector('.collection-tools-panel')).toBeNull();
    expect(document.querySelector('.collection-detail-bar')).toBeTruthy();
    expect(screen.getByRole('region',{name:'권별 표지'})).toBeTruthy();
    // The detail keeps the cover, the volumes and a collapsed metadata disclosure.
    expect(screen.getByRole('button',{name:'밤의 도서관 표지 감상'})).toBeTruthy();
    expect(disclosure().open).toBe(false);
    expect(disclosure().querySelector('summary')?.textContent).toBe('작품 정보');
    fireEvent.click(screen.getByText('작품 정보'));
    expect(disclosure().open).toBe(true);
    expect(metadataBlock().tagName).toBe('DL');
    // Closing the disclosure is its own gesture and keeps the work open.
    fireEvent.click(screen.getByText('작품 정보'));
    expect(disclosure().open).toBe(false);
    expect(screen.getByRole('region',{name:'권별 표지'})).toBeTruthy();
    fireEvent.click(screen.getByText('작품 정보'));
    expect(disclosure().open).toBe(true);
    // Back closes the metadata disclosure first, then the work itself.
    act(()=>{expect(backRef.current?.()).toBe(true);});
    expect(disclosure().open).toBe(false);
    expect(screen.getByRole('region',{name:'권별 표지'})).toBeTruthy();
    act(()=>{expect(backRef.current?.()).toBe(true);});
    expect(document.querySelector('.collection-information')).toBeNull();
    expect(screen.queryAllByRole('region',{name:'권별 표지'})).toHaveLength(0);
    expect(screen.getByRole('group',{name:'컬렉션 유형'})).toBeTruthy();
  });
  it('opens ordered edition covers, requests only the opened original, and backs out one level',async()=>{
    const backRef:{current:(()=>boolean)|null}={current:null};render(<Collections active paused={false} backRef={backRef}/>);
    fireEvent.click(await screen.findByText('밤의 도서관'));
    const editionSelect=async()=>await within(screen.getByRole('button',{name:'목록으로'}).parentElement!).findByRole('combobox',{name:'판본'});
    await editionSelect();
    expect(within(screen.getByRole('region',{name:'권별 표지'})).getAllByRole('button').map(el=>el.lastElementChild?.textContent)).toEqual(['1권','2권']);
    expect(mocks.native.mock.calls.some(([,payload])=>payload.variant==='original')).toBe(false);
    fireEvent.click(screen.getByText('1권'));await screen.findByRole('dialog');await waitFor(()=>expect(mocks.native).toHaveBeenCalledWith('collectionArtwork',expect.objectContaining({artworkId:'c1',variant:'original',revision:'r1'}),expect.any(AbortSignal)));
    expect(within(screen.getByRole('dialog')).getAllByText('1권')).toHaveLength(1);
    expect(within(screen.getByRole('dialog')).queryByText('표지')).toBeNull();
    act(()=>{expect(backRef.current?.()).toBe(true);});expect(screen.queryByRole('dialog')).toBeNull();
    fireEvent.change(await editionSelect(),{target:{value:'1'}});expect(screen.queryByText('2권')).toBeNull();expect(screen.getByText('특별판 1권')).toBeTruthy();
    act(()=>{expect(backRef.current?.()).toBe(true);});expect(screen.queryAllByRole('heading',{level:1})).toHaveLength(0);expect(mocks.api.mock.calls.every(([, ,body])=>body===undefined)).toBe(true);
    expect(screen.queryAllByRole('button',{name:/편집|삭제|가져오기|게시/})).toHaveLength(0);
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
/**
 * jsdom does not lay text out, so the caption rules are asserted on the elements that own them.
 * A long title plus a missing creator is the case that used to change the card's height: the
 * reserved two-line title area is what keeps every card the same size.
 */
it('bounds every card caption without dropping the full work value',async()=>{
  const long={...item,id:'long',name:'아주 길고 긴 한국어 작품 제목이 두 줄을 넘어가는 경우',developer:'매우 길게 이어지는 개발사 이름 예시'};
  mocks.api.mockImplementation(async(path:string)=>path.includes('?')?{...page,items:[long]}:{revision:'r1',item:long});
  render(<Collections active paused={false} backRef={{current:null}}/>);await screen.findByText(long.name);
  const card=screen.getByLabelText('컬렉션',{selector:'section'}).querySelector('.collection-grid .collection-tile') as HTMLElement;
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
  expect((await screen.findByRole('heading',{level:1})).textContent).toBe(long.name);
  expect(screen.getByLabelText('작품 정보',{selector:'details .collection-metadata'}).textContent).toContain(long.developer);
});
/** The detail identity names each type's own maker role, so the grid caption never has to. */
it.each([['game','개발사','아주 긴 개발사 이름'],['manga','작가','아주 긴 작가 이름'],['movie','제작사','아주 긴 제작사 이름']] as const)('names the %s maker role in the detail identity',async(type,role,name)=>{
  const fields=type==='game'?{developer:name}:type==='manga'?{author:name}:{productionCompany:name};
  const work={...item,...fields,type};
  mocks.api.mockImplementation(async(path:string)=>path.includes('?')?{...page,items:[work]}:{revision:'r1',item:work});
  render(<Collections active paused={false} backRef={{current:null}}/>);
  fireEvent.click(await screen.findByText(item.name));
  expect(await screen.findByText(`${role} · ${name}`)).toBeTruthy();
  expect(screen.getByText('작품 정보').closest('details')?.querySelector('.collection-metadata')?.textContent).toContain(name);
});
