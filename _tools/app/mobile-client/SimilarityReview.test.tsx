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
import {mediaTicket,warmThumbnail} from './media';
import {SimilarityReview,SimilarityReviewEntry} from './SimilarityReview';
import {commitSimilarityDecision,readSimilarityIntents} from './similarityReviewOutbox';

(globalThis as {IS_REACT_ACT_ENVIRONMENT?:boolean}).IS_REACT_ACT_ENVIRONMENT=true;
const LIBRARY='e'.repeat(32),SHA='a'.repeat(64),REV='f'.repeat(64);
const side=(assetId:string,width=1200,height=1600,byteSize=200000,format='JPEG')=>({assetId,sha256:SHA,width,height,byteSize,format,sourceLabel:'x.com/a',collectedAt:'2026-09-20T10:00:00Z',classifications:['원본'],asset:{id:assetId,kind:'image',width,height} as Asset});
const pair=(reviewId:string,a:ReturnType<typeof side>,b:ReturnType<typeof side>,recommendation:'keep_existing'|'replace_existing'|null=null)=>
  ({reviewId,kind:'historical',distance:3,recommendedAssetId:recommendation==='keep_existing'?a.assetId:recommendation==='replace_existing'?b.assetId:null,recommendation,a,b});
const feed=(over:Record<string,unknown>={})=>({version:1,ready:true,libraryId:LIBRARY,revision:REV,generatedAt:'g',
  counts:{open:3,pendingPc:0,skipped:0},
  items:[pair('r1',side('a',2400,3200,800000,'PNG'),side('s1'),'keep_existing'),pair('r2',side('s1'),side('s2')),pair('r3',side('s3'),side('s4'))],
  nextCursor:null,hasMore:false,...over});
function install(reply:unknown){
  mocks.api.mockImplementation(async(path:string)=>{
    if(path.startsWith('/v1/library/similarity/review?')){if(reply instanceof Error)throw reply;return reply;}
    throw new ApiError('offline',null,null);
  });
}
function mount(){
  const back={current:null as (()=>boolean)|null};const onClose=vi.fn();
  render(<SimilarityReview backRef={back} onClose={onClose}/>);
  return {back,onClose};
}
const choose=(name:RegExp)=>fireEvent.click(screen.getByRole('button',{name}));
const shown=()=>screen.getByLabelText('A 정보').textContent;
const doubleTap=(target:HTMLElement)=>{for(let i=0;i<2;i++){fireEvent.pointerDown(target,{pointerId:1,button:0,clientX:10,clientY:10});fireEvent.pointerUp(target,{pointerId:1,clientX:10,clientY:10});}};
const scales=()=>screen.getAllByRole('img').map(img=>(img as HTMLImageElement).style.transform.match(/scale\(([\d.]+)\)/)?.[1]);

afterEach(()=>{cleanup();localStorage.clear();vi.useRealTimers();});
beforeEach(()=>{setOutboxConnection(CONNECTION);localStorage.clear();mocks.api.mockReset();vi.mocked(warmThumbnail).mockClear();vi.mocked(mediaTicket).mockClear();});

describe('similarity review screen',()=>{
  it('shows A and B with metadata, accents the larger image, marks the recommendation and warms the next pairs',async()=>{
    install(feed({counts:{open:3,pendingPc:4,skipped:2}}));mount();
    expect(await screen.findByLabelText('A 정보')).toBeTruthy();
    expect(shown()).toContain('2,400 × 3,200');
    expect(shown()).toContain('PNG');
    expect(shown()).toContain('권장');
    expect(screen.getByLabelText('A 정보').querySelectorAll('[data-accent]')).toHaveLength(2);
    expect(screen.getByLabelText('B 정보').querySelectorAll('[data-accent]')).toHaveLength(0);
    expect(screen.getByRole('button',{name:/A 유지 · B 휴지통/}).textContent).toContain('권장');
    expect(screen.getByRole('button',{name:/B 유지 · A 휴지통/}).textContent).not.toContain('권장');
    expect(screen.getByText('PC가 반영하기 전까지 원본은 바뀌지 않습니다. 버린 이미지는 휴지통으로 갑니다.')).toBeTruthy();
    expect(screen.getByText('0 / 3 · PC 반영 대기 4 · 건너뜀 2')).toBeTruthy();
    // Warming runs in a passive effect, which React may flush after the DOM this test waited for.
    await waitFor(()=>expect(vi.mocked(warmThumbnail).mock.calls.map(([asset])=>asset.id)).toEqual(['s1','s2','s3','s4']));
    // Thumbnails only until zoom.
    expect(mediaTicket).not.toHaveBeenCalled();
  });
  it('queues a decision with its basis, hides pairs holding the trashed image, and undoes both',async()=>{
    install(feed());mount();
    await screen.findByLabelText('A 정보');
    choose(/A 유지 · B 휴지통/);
    expect(readSimilarityIntents()['r1']).toMatchObject({decision:'keep_existing',libraryId:LIBRARY,aAssetId:'a',bAssetId:'s1',basis:{feedRevision:REV,aSha256:SHA,bSha256:SHA}});
    // r2 holds s1, which r1 will trash, so the next pair is r3.
    await waitFor(()=>expect(screen.getByLabelText('A 정보').textContent).toContain('1,200 × 1,600'));
    expect(screen.getByText('1 / 3 · PC 반영 대기 1')).toBeTruthy();
    expect(screen.getByText('A 유지 · B 휴지통으로 저장')).toBeTruthy();
    choose(/둘 다 보관/);
    expect(await screen.findByText('모두 검토했습니다')).toBeTruthy();
    choose(/되돌리기/);choose(/되돌리기/);
    expect(readSimilarityIntents()).toEqual({});
    await waitFor(()=>expect(shown()).toContain('2,400 × 3,200'));
    expect(screen.getByText('0 / 3')).toBeTruthy();
    expect(screen.queryByRole('button',{name:/되돌리기/})).toBeNull();
    choose(/B 유지 · A 휴지통/);
    expect(readSimilarityIntents()['r1'].decision).toBe('replace_existing');
    // Replacing A trashes `a`, so r2 (s1/s2) stays.
    await waitFor(()=>expect(screen.getByText('1 / 3 · PC 반영 대기 1')).toBeTruthy());
  });
  it('undo after sending queues a withdrawal and keeps only five undo steps',async()=>{
    const many=Array.from({length:7},(_,i)=>pair(`r${i}`,side(`a${i}`),side(`b${i}`)));
    install(feed({items:many,counts:{open:7,pendingPc:0,skipped:0}}));mount();
    await screen.findByLabelText('A 정보');
    choose(/둘 다 보관/);
    localStorage.clear(); // Sent and confirmed meanwhile.
    choose(/되돌리기/);
    expect(readSimilarityIntents()['r0:withdrawn'].decision).toBe('withdrawn');
    for(let i=0;i<7;i++){await waitFor(()=>expect(screen.getByRole('button',{name:/둘 다 보관/}).hasAttribute('disabled')).toBe(false));choose(/둘 다 보관/);}
    for(let i=0;i<5;i++)choose(/되돌리기/);
    expect(screen.queryByRole('button',{name:/되돌리기/})).toBeNull();
  });
  it('zooms both images together, loads originals, and Back resets zoom before closing',async()=>{
    install(feed());const {back,onClose}=mount();
    await screen.findByLabelText('A 정보');
    await waitFor(()=>expect(screen.getAllByRole('img')).toHaveLength(2));
    doubleTap(screen.getByLabelText('A 이미지',{selector:'div'}));
    await waitFor(()=>expect(scales()).toEqual(['2','2']));
    expect(vi.mocked(mediaTicket).mock.calls.map(([asset,variant])=>[asset.id,variant])).toEqual([['a','original'],['s1','original']]);
    act(()=>{expect(back.current?.()).toBe(true);});
    expect(scales()).toEqual(['1','1']);
    expect(onClose).not.toHaveBeenCalled();
    act(()=>{back.current?.();});
    expect(onClose).toHaveBeenCalledTimes(1);
  });
  it('compares in one pane with hold, automatic flicker and a wipe divider',async()=>{
    install(feed());mount();
    await screen.findByLabelText('A 정보');
    fireEvent.click(screen.getByRole('button',{name:'한 화면에서 비교'}));
    const stage=screen.getByLabelText('비교 화면');
    expect(stage.dataset.showing).toBe('A');
    const hold=screen.getByRole('button',{name:'누르는 동안 B 보기'});
    fireEvent.pointerDown(hold);expect(stage.dataset.showing).toBe('B');
    fireEvent.pointerUp(hold);expect(stage.dataset.showing).toBe('A');
    vi.useFakeTimers();
    fireEvent.click(screen.getByRole('button',{name:'자동 깜빡임'}));
    act(()=>{vi.advanceTimersByTime(500);});
    expect(screen.getByLabelText('비교 화면').dataset.showing).toBe('B');
    act(()=>{vi.advanceTimersByTime(500);});
    expect(screen.getByLabelText('비교 화면').dataset.showing).toBe('A');
    fireEvent.click(screen.getByRole('button',{name:'자동 깜빡임 멈춤'}));
    act(()=>{vi.advanceTimersByTime(1500);});
    expect(screen.getByLabelText('비교 화면').dataset.showing).toBe('A');
    vi.useRealTimers();
    fireEvent.click(screen.getByRole('tab',{name:'와이프'}));
    fireEvent.change(screen.getByLabelText('와이프 위치'),{target:{value:'30'}});
    const layer=screen.getByLabelText('비교 화면').querySelector('.similarity-layer') as HTMLElement;
    expect(layer.style.clipPath).toBe('inset(0 0 0 30%)');
    fireEvent.click(screen.getByRole('button',{name:'나란히 보기'}));
    expect(screen.queryByLabelText('비교 화면')).toBeNull();
  });
  it('explains PC update, offline with saved decisions, and an old server',async()=>{
    install(feed({ready:false,items:[],counts:{open:0,pendingPc:0,skipped:0}}));mount();
    expect(await screen.findByText('PC 업데이트가 필요합니다')).toBeTruthy();
    cleanup();
    commitSimilarityDecision({libraryId:LIBRARY,reviewId:'x',decision:'keep_both',basis:{feedRevision:REV,aSha256:SHA,bSha256:SHA},aAssetId:'p',bAssetId:'q'});
    install(new ApiError('offline',null,null));mount();
    expect(await screen.findByText('오프라인입니다')).toBeTruthy();
    expect(screen.getByText('저장된 결정 1개는 연결되면 PC로 전송됩니다.')).toBeTruthy();
    cleanup();
    install(new ApiError('not found',404,null));mount();
    expect(await screen.findByText('서버에 유사 이미지 검토 업데이트가 필요합니다.')).toBeTruthy();
  });
});

describe('similarity review entry',()=>{
  it('shows the Library row only with a positive count, minus queued local decisions',async()=>{
    install(feed());
    commitSimilarityDecision({libraryId:LIBRARY,reviewId:'r1',decision:'keep_both',basis:{feedRevision:REV,aSha256:SHA,bSha256:SHA},aAssetId:'a',bAssetId:'s1'});
    const open=vi.fn();
    render(<SimilarityReviewEntry enabled refreshKey={1} onOpen={open}/>);
    fireEvent.click(await screen.findByRole('button',{name:'유사 이미지 검토 2개'}));
    expect(open).toHaveBeenCalled();
    cleanup();
    install(feed({ready:false,counts:{open:0,pendingPc:0,skipped:0}}));
    render(<SimilarityReviewEntry enabled refreshKey={2} onOpen={open}/>);
    await waitFor(()=>expect(mocks.api).toHaveBeenCalledTimes(2));
    expect(screen.queryByRole('button')).toBeNull();
    cleanup();mocks.api.mockClear();
    render(<SimilarityReviewEntry enabled={false} refreshKey={1} onOpen={open}/>);
    expect(mocks.api).not.toHaveBeenCalled();
  });
});
