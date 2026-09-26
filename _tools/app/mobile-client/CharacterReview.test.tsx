import {act,cleanup,fireEvent,render,screen,waitFor} from '@testing-library/react';
import {afterEach,beforeEach,describe,expect,it,vi} from 'vitest';
import {setOutboxConnection} from './outboxConnection';
const CONNECTION='https://a.example';
import type {Asset} from './types';

const mocks=vi.hoisted(()=>({api:vi.fn()}));
vi.mock('./transport',()=>({api:mocks.api,native:vi.fn(),
  ApiError:class ApiError extends Error{status:number|null;details:unknown;constructor(message:string,status:number|null,details:unknown){super(message);this.status=status;this.details=details;}},
  errorText:(error:Error)=>error.message}));
vi.mock('./media',()=>({
  loadThumbnail:vi.fn((asset:Asset)=>Promise.resolve({...asset,preview:`thumb:${asset.id}`})),
  mediaTicket:vi.fn(()=>new Promise(()=>{})),decodeImage:vi.fn(),warmThumbnail:vi.fn(()=>Promise.resolve()),
}));
import {ApiError} from './transport';
import {warmThumbnail} from './media';
import {CharacterReview,CharacterReviewEntry} from './CharacterReview';
import {CharacterAddSheet} from './CharacterAddSheet';
import {commitReviewDecision,readReviewIntents} from './characterReviewOutbox';

(globalThis as {IS_REACT_ACT_ENVIRONMENT?:boolean}).IS_REACT_ACT_ENVIRONMENT=true;
const LIBRARY='e'.repeat(32);
const asset=(id:string):Asset=>({id,kind:'image'});
const item=(assetId:string,targetId='c',sources=['s36'])=>({targetId,assetId,sources,verdict:'recommended',knn3:0.8,basis:'b1',asset:asset(assetId)});
const feed=(over:Record<string,unknown>={})=>({version:1,ready:true,libraryId:LIBRARY,revision:'r'.repeat(64),generatedAt:'g',
  counts:{total:3,s36:2,b36:1,doubtful:0,pendingPc:0,skipped:0},
  items:[item('a1'),item('a2','c',['b36']),item('a3','d')],
  targets:{c:{name:'루미',seriesId:'s',seriesName:'시리즈',references:[asset('ref-1')]},d:{name:'둘째',seriesId:'s',seriesName:'시리즈',references:[]}},
  nextCursor:null,hasMore:false,...over});
/** GET review answers `reply`; decision sends fail as transport errors so intents stay queued. */
function install(reply:unknown){
  mocks.api.mockImplementation(async(path:string)=>{
    if(path.startsWith('/v1/library/characters/review?')){if(reply instanceof Error)throw reply;return reply;}
    throw new ApiError('offline',null,null);
  });
}
function mount(){
  const back={current:null as (()=>boolean)|null};const onClose=vi.fn();
  render(<CharacterReview libraryId={LIBRARY} backRef={back} onClose={onClose}/>);
  return {back,onClose};
}
const candidate=()=>screen.getByLabelText('검토 후보');
const swipe=(dx:number,dy=0)=>{const card=candidate();fireEvent.pointerDown(card,{pointerId:1,button:0,clientX:500,clientY:500});fireEvent.pointerMove(card,{pointerId:1,clientX:500+dx,clientY:500+dy});fireEvent.pointerUp(card,{pointerId:1,clientX:500+dx,clientY:500+dy});};

afterEach(()=>{cleanup();localStorage.clear();});
beforeEach(()=>{setOutboxConnection(CONNECTION);localStorage.clear();mocks.api.mockReset();vi.mocked(warmThumbnail).mockClear();});

describe('character review screen',()=>{
  it('shows the candidate with its character, source and references, and warms the next ones',async()=>{
    install(feed());mount();
    expect(await screen.findByText('루미')).toBeTruthy();
    expect(screen.getByText('시리즈')).toBeTruthy();
    expect(screen.getByText('S36 추천')).toBeTruthy();
    expect(screen.getAllByLabelText('기준 이미지 크게 보기')).toHaveLength(1);
    expect(screen.getByText('0 / 3')).toBeTruthy();
    // Warming runs in a passive effect, which React may flush after the DOM this test waited for.
    await waitFor(()=>expect(vi.mocked(warmThumbnail).mock.calls.map(([a])=>a.id)).toEqual(['a2','a3']));
  });
  it('queues 맞음/아님 from buttons and swipes, skips locally, and hides queued pairs',async()=>{
    install(feed());mount();
    await screen.findByText('루미');
    fireEvent.click(screen.getByRole('button',{name:/맞음/}));
    expect(readReviewIntents()['c:a1']).toMatchObject({decision:'accepted',origin:'feed',basis:'b1',libraryId:LIBRARY});
    expect(await screen.findByText('B36 추천')).toBeTruthy();
    expect(screen.getByText('1 / 3 · PC 반영 대기 1')).toBeTruthy();
    swipe(-420);
    expect(readReviewIntents()['c:a2'].decision).toBe('rejected');
    expect(await screen.findByText('둘째')).toBeTruthy();
    swipe(0,-400);
    expect(readReviewIntents()['d:a3']).toBeUndefined();
    expect(await screen.findByText('모두 검토했습니다')).toBeTruthy();
    expect(screen.getByRole('button',{name:'건너뛴 1개 다시 보기'})).toBeTruthy();
    // A small drag snaps back instead of deciding.
    cleanup();install(feed());mount();
    // a1 and a2 are still queued; the skipped a3 is remembered and waits behind everything else.
    fireEvent.click(await screen.findByRole('button',{name:'건너뛴 1개 다시 보기'}));
    expect(await screen.findByText('둘째')).toBeTruthy();
    expect(screen.queryByText('루미')).toBeNull();
    // A slow, short drag snaps back; the same distance as a quick fling decides.
    const clock=vi.spyOn(performance,'now');
    clock.mockReturnValueOnce(0).mockReturnValueOnce(2000);
    swipe(120);
    expect(readReviewIntents()['d:a3']).toBeUndefined();
    clock.mockRestore();
    swipe(420);
    await waitFor(()=>expect(readReviewIntents()['d:a3'].decision).toBe('accepted'));
  });
  it('undoes up to five actions, removing unsent intents and bringing candidates back',async()=>{
    install(feed());mount();
    await screen.findByText('루미');
    fireEvent.click(screen.getByRole('button',{name:/맞음/}));
    await screen.findByText('B36 추천');
    fireEvent.click(screen.getByRole('button',{name:/건너뛰기/}));
    await screen.findByText('둘째');
    fireEvent.click(screen.getByRole('button',{name:/되돌리기/}));
    expect(await screen.findByText('B36 추천')).toBeTruthy();
    fireEvent.click(screen.getByRole('button',{name:/되돌리기/}));
    expect(await screen.findByText('S36 추천')).toBeTruthy();
    expect(readReviewIntents()).toEqual({});
    expect(screen.getByText('0 / 3')).toBeTruthy();
    expect(screen.queryByRole('button',{name:/되돌리기/})).toBeNull();
  });
  it('undo of a decision the server already confirmed queues cleared',async()=>{
    install(feed());mount();
    await screen.findByText('루미');
    fireEvent.click(screen.getByRole('button',{name:/맞음/}));
    await screen.findByText('B36 추천');
    localStorage.clear(); // Confirmed by the server meanwhile.
    fireEvent.click(screen.getByRole('button',{name:/되돌리기/}));
    expect(readReviewIntents()['c:a1'].decision).toBe('cleared');
    expect(await screen.findByText('S36 추천')).toBeTruthy();
  });
  it('Back closes the reference zoom first, then the screen',async()=>{
    install(feed());const {back,onClose}=mount();
    await screen.findByText('루미');
    fireEvent.click(screen.getByLabelText('기준 이미지 크게 보기'));
    expect(screen.getByRole('dialog',{name:'기준 이미지'})).toBeTruthy();
    act(()=>{expect(back.current?.()).toBe(true);});
    expect(screen.queryByRole('dialog',{name:'기준 이미지'})).toBeNull();
    expect(onClose).not.toHaveBeenCalled();
    act(()=>{back.current?.();});
    expect(onClose).toHaveBeenCalledTimes(1);
  });
  it('explains PC update, offline with saved decisions, and an old server',async()=>{
    install(feed({ready:false,items:[],counts:{total:0,s36:0,b36:0,doubtful:0,pendingPc:0,skipped:0}}));mount();
    expect(await screen.findByText('PC 업데이트가 필요합니다')).toBeTruthy();
    cleanup();
    commitReviewDecision({libraryId:LIBRARY,targetId:'c',assetId:'x',decision:'accepted',origin:'feed',basis:null});
    install(new ApiError('offline',null,null));mount();
    expect(await screen.findByText('오프라인입니다')).toBeTruthy();
    expect(screen.getByText('저장된 결정 1개는 연결되면 PC로 전송됩니다.')).toBeTruthy();
    cleanup();
    install(new ApiError('not found',404,null));mount();
    expect(await screen.findByText('서버에 캐릭터 검토 업데이트가 필요합니다.')).toBeTruthy();
  });
  it('shows pending and PC-skipped counts', async()=>{
    install(feed({counts:{total:3,s36:2,b36:1,doubtful:0,pendingPc:4,skipped:2}}));mount();
    expect(await screen.findByText('0 / 3 · PC 반영 대기 4 · PC가 건너뜀 2')).toBeTruthy();
  });
});

describe('review entry points and viewer add sheet',()=>{
  it('shows the Library row only with a positive count, minus queued local decisions',async()=>{
    install(feed());
    commitReviewDecision({libraryId:LIBRARY,targetId:'c',assetId:'a1',decision:'accepted',origin:'feed',basis:'b1'});
    const open=vi.fn();
    render(<CharacterReviewEntry enabled refreshKey={1} onOpen={open}/>);
    fireEvent.click(await screen.findByRole('button',{name:'캐릭터 검토 2개'}));
    expect(open).toHaveBeenCalled();
    cleanup();mocks.api.mockClear();
    render(<CharacterReviewEntry enabled={false} refreshKey={1} onOpen={open}/>);
    expect(screen.queryByRole('button')).toBeNull();
    expect(mocks.api).not.toHaveBeenCalled();
  });
  it('offers the asset series characters and queues a viewer accept',async()=>{
    mocks.api.mockImplementation(async(path:string)=>{
      if(path==='/v1/library/characters/review?asset=a9')return {version:1,ready:true,assetId:'a9',targets:[{targetId:'c',name:'루미',seriesId:'s',seriesName:'시리즈'},{targetId:'d',name:'둘째',seriesId:'s',seriesName:'시리즈'}]};
      throw new ApiError('offline',null,null);
    });
    const added=vi.fn();
    render(<CharacterAddSheet assetId="a9" libraryId={LIBRARY} onClose={()=>{}} onAdded={added}/>);
    fireEvent.click(await screen.findByRole('button',{name:/둘째/}));
    expect(readReviewIntents()['d:a9']).toMatchObject({decision:'accepted',origin:'viewer',basis:null});
    expect(added).toHaveBeenCalledWith('둘째');
  });
});
