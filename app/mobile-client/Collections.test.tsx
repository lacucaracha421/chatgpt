import {act, cleanup, fireEvent, render, screen, waitFor, within} from '@testing-library/react';
import {afterEach, beforeEach, describe, expect, it, vi} from 'vitest';
import {collectionPath, editionVolumes, editions} from './collectionModel';
import type {CollectionDetail, CollectionPage} from './collectionModel';
const mocks=vi.hoisted(()=>({api:vi.fn(),native:vi.fn()}));
vi.mock('./transport',()=>({api:mocks.api,native:mocks.native,errorText:(reason:unknown)=>String(reason)}));
vi.mock('./media',()=>({mediaTicket:vi.fn()}));
import {Collections} from './Collections';
const item:CollectionDetail={id:'manga-1',name:'밤의 도서관',type:'manga',showcase:true,selectedWorkArtworkId:'cover',volumes:[{id:'v2',volumeNumber:2,editionIndex:0,displayLabel:'2권',coverArtworkId:'c2'},{id:'e1',volumeNumber:1,editionIndex:1,displayLabel:'특별판 1권',coverArtworkId:'e1'},{id:'v1',volumeNumber:1,editionIndex:0,displayLabel:'1',coverArtworkId:'c1'}],artworks:[]};
const page:CollectionPage={ready:true,revision:'r1',publishedAt:null,items:[item],nextCursor:null};
beforeEach(()=>{mocks.api.mockReset();mocks.native.mockReset();mocks.api.mockImplementation(async(path:string)=>path.includes('/v1/collections/')?{revision:'r1',item}:page);mocks.native.mockResolvedValue({url:'https://example.invalid/cover',expires_in:300});});
afterEach(cleanup);
describe('read-only collections',()=>{
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
    fireEvent.click(screen.getByRole('button',{name:'검색',exact:true}));await screen.findByText('밤의 도서관');expect(mocks.api).toHaveBeenCalledTimes(2);
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
