import {act,cleanup,fireEvent,render,screen,waitFor} from '@testing-library/react';
import {afterEach,beforeEach,describe,expect,it,vi} from 'vitest';
import {setOutboxConnection} from './outboxConnection';
const CONNECTION='https://a.example';

const mocks=vi.hoisted(()=>({api:vi.fn()}));
vi.mock('./transport',()=>({api:mocks.api,native:vi.fn(),
  ApiError:class ApiError extends Error{status:number|null;details:unknown;constructor(message:string,status:number|null,details:unknown){super(message);this.status=status;this.details=details;}},
  errorText:(error:Error)=>error.message}));
vi.mock('./catalogMedia',()=>({catalogImageTicket:vi.fn(async(request:{workId:string})=>({url:`data:image/png;base64,${request.workId}`}))}));
import {ApiError} from './transport';
import {CatalogDuplicates,DuplicateReviewEntry} from './CatalogDuplicates';
import {DUPLICATE_DECISIONS_PATH,DUPLICATE_SEND_DELAY_MS,flushDuplicateDecisions,readDuplicateIntents} from './catalogDuplicates';

(globalThis as {IS_REACT_ACT_ENVIRONMENT?:boolean}).IS_REACT_ACT_ENVIRONMENT=true;
const C1='a'.repeat(32),C2='b'.repeat(32);
const work=(workId:string,title:string,pages=24)=>({workId,groupId:null,title,titleJpn:null,pages,category:2,creators:['artist:kim','group:studio'],languages:['korean']});
const candidate=(candidateId:string,left:string,right:string,decision:string|null=null,decisionRevision=0)=>({
  candidateId,provider:'kHentai',leftWorkId:left,rightWorkId:right,source:'pc',reason:'exactTitle',pageGap:0,
  reasonText:'제목 일치 · 작가/그룹 중복 · 페이지 수, 분류, 언어 일치',algorithm:'x',
  left:work(left,`Title ${left}`),right:work(right,`Title ${right}`,26),removed:false,revision:7,
  decision:decision?{decision,hiddenWorkId:null}:null,decisionRevision});
const feed=(items:unknown[],counts={undecided:items.length,decided:0})=>({version:1,revision:9,pcGeneration:'g',counts,items,nextCursor:null,hasMore:false});
type Body={operationId:string;candidateId:string;decision:string;expectedRevision:number};
let lists:Record<string,unknown>;
let decide:(body:Body)=>unknown;
function install(){
  mocks.api.mockImplementation(async(path:string,_signal:unknown,body?:Body)=>{
    if(path.startsWith('/v1/mobile-catalog/duplicates?')){const reply=lists[new URLSearchParams(path.split('?')[1]).get('state')!];if(reply instanceof Error)throw reply;return reply;}
    if(path===DUPLICATE_DECISIONS_PATH&&body){const reply=decide(body);if(reply instanceof Error)throw reply;return reply;}
    const detail=path.match(/^\/v1\/mobile-catalog\/works\/kHentai\/(\w+)\?context=ctx$/);
    if(detail){if(detail[1]==='w4')throw new ApiError('gone',404,null);return {publicationRevision:'r'.repeat(64),item:{thumbnailUrl:`https://covers/${detail[1]}`}};}
    throw new ApiError('offline',null,null);
  });
}
const mount=()=>{const onClose=vi.fn();render(<CatalogDuplicates context="ctx" onClose={onClose}/>);return onClose;};
const posted=()=>mocks.api.mock.calls.filter(([path])=>path===DUPLICATE_DECISIONS_PATH).map(([, ,body])=>body as Body);

beforeEach(()=>{setOutboxConnection(CONNECTION);localStorage.clear();mocks.api.mockReset();decide=body=>({operationId:body.operationId});lists={undecided:feed([]),decided:feed([])};install();});
afterEach(()=>{cleanup();localStorage.clear();});

describe('catalog duplicate review',()=>{
  it('shows a friendly empty state and the PC note',async()=>{
    mount();
    expect(await screen.findByText('검토할 중복 판본이 없어요')).toBeTruthy();
    expect(screen.getByText(/PC가 켜지면 카탈로그에 반영돼요/)).toBeTruthy();
    fireEvent.click(screen.getByRole('tab',{name:/처리됨/}));
    expect(await screen.findByText('처리한 판본이 없어요')).toBeTruthy();
  });
  it('lists pairs with covers, titles, pages, creators, language and the reason; a missing cover is a placeholder',async()=>{
    lists.undecided=feed([candidate(C1,'w1','w2'),candidate(C2,'w3','w4')]);
    mount();
    expect(await screen.findByText('Title w1')).toBeTruthy();
    expect(screen.getByText('Title w2')).toBeTruthy();
    expect(screen.getAllByText('kim · studio')).toHaveLength(4);
    expect(screen.getAllByText('26p · korean')).toHaveLength(2);
    expect(screen.getAllByText('24p · korean')).toHaveLength(2);
    expect(screen.getAllByText('제목 일치 · 작가/그룹 중복 · 페이지 수, 분류, 언어 일치')).toHaveLength(2);
    expect(screen.getByRole('tab',{name:/확인 필요\s*2/})).toBeTruthy();
    await waitFor(()=>expect(document.querySelectorAll('.catalog-cover-image img')).toHaveLength(3));
    expect(document.querySelectorAll('.duplicate-cover-missing')).toHaveLength(1);
  });
  it('queues "같은 작품으로 묶기" as keepBoth, hides the pair, and undoes it',async()=>{
    lists.undecided=feed([candidate(C1,'w1','w2')]);
    mount();
    await screen.findByText('Title w1');
    fireEvent.click(screen.getByRole('button',{name:'같은 작품으로 묶기'}));
    expect(readDuplicateIntents()[C1]).toMatchObject({decision:'keepBoth',expectedRevision:0,base:null});
    expect(await screen.findByText('검토할 중복 판본이 없어요')).toBeTruthy();
    expect(screen.getByText('같은 작품으로 묶었어요')).toBeTruthy();
    expect(screen.getByText(/전송 대기 1/)).toBeTruthy();
    fireEvent.click(screen.getByRole('button',{name:/되돌리기/}));
    expect(readDuplicateIntents()).toEqual({});
    expect(await screen.findByText('Title w1')).toBeTruthy();
    fireEvent.click(screen.getByRole('button',{name:'다른 작품'}));
    expect(readDuplicateIntents()[C1].decision).toBe('notDuplicate');
  });
  it('sends both decisions with expectedRevision and operationId, including a change of an auto-merged pair',async()=>{
    lists.undecided=feed([candidate(C1,'w1','w2')]);
    lists.decided=feed([candidate(C2,'w3','w5','keepBoth',2)],{undecided:1,decided:1});
    mount();
    await screen.findByText('Title w1');
    fireEvent.click(screen.getByRole('button',{name:'다른 작품'}));
    fireEvent.click(screen.getByRole('tab',{name:/처리됨/}));
    expect(await screen.findByText('같은 작품으로 묶음')).toBeTruthy();
    fireEvent.click(screen.getByRole('button',{name:'다른 작품'}));
    expect(screen.getByText('· 전송 대기')).toBeTruthy();
    await act(async()=>{await flushDuplicateDecisions(()=>Date.now()+DUPLICATE_SEND_DELAY_MS+1);});
    expect(posted()).toEqual([
      {version:1,operationId:expect.any(String),candidateId:C1,decision:'notDuplicate',expectedRevision:0},
      {version:1,operationId:expect.any(String),candidateId:C2,decision:'notDuplicate',expectedRevision:2},
    ]);
    expect(new Set(posted().map(body=>body.operationId)).size).toBe(2);
    expect(readDuplicateIntents()).toEqual({});
  });
  it('shows the conflict message and re-reads the list when another device decided first',async()=>{
    lists.undecided=feed([candidate(C1,'w1','w2')]);
    decide=()=>new ApiError('conflict',409,{detail:{code:'duplicateDecisionConflict',message:'다른 기기에서 먼저 검토했습니다. 새로고침해 주세요.'}});
    mount();
    await screen.findByText('Title w1');
    fireEvent.click(screen.getByRole('button',{name:'같은 작품으로 묶기'}));
    const reads=()=>mocks.api.mock.calls.filter(([path])=>String(path).startsWith('/v1/mobile-catalog/duplicates?')).length;
    const before=reads();
    await act(async()=>{await flushDuplicateDecisions(()=>Date.now()+DUPLICATE_SEND_DELAY_MS+1);});
    expect(await screen.findByText('다른 기기에서 먼저 검토했습니다. 새로고침해 주세요.')).toBeTruthy();
    expect(readDuplicateIntents()).toEqual({});
    await waitFor(()=>expect(reads()).toBeGreaterThan(before));
    expect(await screen.findByText('Title w1')).toBeTruthy();
  });
  it('keeps decisions queued offline and says they are sent once connected',async()=>{
    lists.undecided=feed([candidate(C1,'w1','w2')]);
    mount();
    await screen.findByText('Title w1');
    fireEvent.click(screen.getByRole('button',{name:'같은 작품으로 묶기'}));
    decide=()=>new ApiError('offline',null,null);
    await expect(flushDuplicateDecisions(()=>Date.now()+DUPLICATE_SEND_DELAY_MS+1)).rejects.toThrow('offline');
    expect(readDuplicateIntents()[C1].decision).toBe('keepBoth');
    cleanup();
    lists.undecided=new ApiError('offline',null,null);
    mount();
    expect(await screen.findByText('오프라인이에요')).toBeTruthy();
    expect(screen.getByText('저장된 결정 1개는 연결되면 전송돼요.')).toBeTruthy();
  });
  it('entry shows a count only when some pairs need a look',()=>{
    const onOpen=vi.fn();
    const {rerender}=render(<DuplicateReviewEntry count={0} onOpen={onOpen}/>);
    expect(screen.getByRole('button',{name:'중복 판본 검토'})).toBeTruthy();
    rerender(<DuplicateReviewEntry count={3} onOpen={onOpen}/>);
    fireEvent.click(screen.getByRole('button',{name:'중복 판본 검토, 확인 필요 3개'}));
    expect(onOpen).toHaveBeenCalled();
  });
});
