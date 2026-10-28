import '@testing-library/jest-dom/vitest';
import {cleanup,fireEvent,render,screen,waitFor,within} from '@testing-library/react';
import {afterEach,beforeEach,expect,it,vi} from 'vitest';
import {setOutboxConnection} from './outboxConnection';
const mocks=vi.hoisted(()=>({api:vi.fn(),native:vi.fn()}));
vi.mock('./transport',async()=>({...await vi.importActual<typeof import('./transport')>('./transport'),...mocks}));
import {AvInbox,InboxEntry,inboxStatus} from './AvInbox';
import {AuthorityQueue} from './CollectionAuthorityForms';
import {AvInboxChooser} from './AvInboxChooser';
import {inboxAuthority,inboxFixture,inboxIdentity,inboxWork} from './avInboxFixtures';
import {PRIVACY_MODE_KEY} from './privacyMode';
import {createInboxPlan,initialChoices,readInboxPlans,type InboxPlan} from './avInboxApply';
import type {InboxDetail,InboxItem} from './avInboxModel';
import type {useCollectionAuthority} from './useCollectionAuthority';
let list:InboxItem[],details:Record<string,InboxDetail>,offline:boolean;
const authority={identity:inboxIdentity,flush:vi.fn()} as unknown as ReturnType<typeof useCollectionAuthority>;
const second={...inboxFixture.inbox,id:'22222222-2222-4222-8222-222222222222',sequence:2,productCode:'ABW-100',normalizedCode:'ABW-100'};
beforeEach(()=>{
  vi.stubGlobal('Image',class {onload:(()=>void)|null=null;set src(value:string){if(value)queueMicrotask(()=>this.onload?.());}});
  vi.spyOn(HTMLCanvasElement.prototype,'getContext').mockReturnValue({drawImage:vi.fn()} as unknown as CanvasRenderingContext2D);
  vi.spyOn(HTMLCanvasElement.prototype,'toDataURL').mockReturnValue('data:image/webp;base64,cropped');
  localStorage.clear();setOutboxConnection('https://test.example');mocks.api.mockReset();mocks.native.mockReset();offline=false;
  list=[inboxFixture.inbox];details={[inboxFixture.inbox.id]:inboxFixture,[second.id]:{...inboxFixture,inbox:second}};
  mocks.native.mockResolvedValue({url:'data:image/jpeg;base64,YQ=='});
  mocks.api.mockImplementation(async(path:string,_signal:unknown,body?:Record<string,unknown>)=>{
    if(offline)throw new Error('offline');
    if(path.startsWith('/v1/av-inbox?'))return {items:list,hasMore:false,nextBefore:null};
    if(path.endsWith('/dismiss')){list=list.filter(item=>!path.includes(item.id));return {};}
    if(path.endsWith('/fix-code')){list=list.map(item=>path.includes(item.id)?{...item,normalizedCode:body!.productCode as string,status:'queued'}:item);return {};}
    if(path.endsWith('/retry'))return {};
    if(path.startsWith('/v1/av-inbox/'))return details[path.split('/')[3]!];
    if(path.includes('/baseline'))return {...inboxIdentity,snapshotCursor:1,items:[],hasMore:false,nextAfter:null};
    if(path==='/v1/av-lookups')return {};
    throw new Error(path);
  });
});
afterEach(()=>{cleanup();document.querySelectorAll('[data-motion-ghost]').forEach(n=>n.remove());vi.restoreAllMocks();vi.unstubAllGlobals();});
const view=(open=true)=>render(<AvInbox active authority={authority} items={[]} open={open} onOpen={vi.fn()} onClose={vi.fn()}/>);
it('counts statuses on the second line and hides an empty entry',()=>{
  const rows=[inboxFixture.inbox,{...second,status:'fetching' as const},{...second,id:'stopped'}];
  const {rerender}=render(<InboxEntry items={rows} plans={[{id:'stopped',state:'blocked'}] as InboxPlan[]} onOpen={vi.fn()}/>);
  expect(screen.getByRole('button',{name:'받은 품번 3'})).toHaveTextContent('후보 있음 1 · 찾는 중 1 · 멈춤 1');
  expect(document.querySelector('.av-inbox-danger')).toHaveTextContent('멈춤 1');
  rerender(<InboxEntry items={[]} plans={[]} onOpen={vi.fn()}/>);expect(screen.queryByRole('button')).toBeNull();
});
it('shows queued/not found/error, progress, ack wait, stopped and done',()=>{
  for(const [status,label] of [['queued','찾는 중'],['not_found','못 찾음'],['error','오류']])expect(inboxStatus({...second,status} as InboxItem)).toBe(label);
  for(const [state,label] of [['sending','보내는 중'],['waiting','확인 기다리는 중'],['blocked','멈춤'],['done','적용됨']])expect(inboxStatus(second,{state} as InboxPlan)).toBe(label);
});
it('places sender inside the sheet and does no candidate reads while closed',async()=>{
  const rendered=view(false);await screen.findByRole('button',{name:'받은 품번 1'});
  expect(screen.queryByRole('textbox',{name:'품번'})).toBeNull();expect(mocks.api.mock.calls.some(([p])=>p===`/v1/av-inbox/${inboxFixture.inbox.id}`)).toBe(false);
  rendered.rerender(<AvInbox active authority={authority} items={[]} open onOpen={vi.fn()} onClose={vi.fn()}/>);
  expect(await screen.findByRole('textbox',{name:'품번'})).toBeTruthy();
});
it('renders newest first, retries, edits inline and confirms candidate discard',async()=>{
  list=[{...second,status:'not_found'},inboxFixture.inbox];view();
  const sheet=await screen.findByRole('dialog',{name:'받은 품번 2'});expect(within(sheet).getAllByText(/SSIS-001|ABW-100/,{selector:'b'})[0]).toHaveTextContent('SSIS-001');
  fireEvent.click(screen.getByRole('button',{name:'다시 시도'}));await waitFor(()=>expect(mocks.api.mock.calls.some(([p])=>p.endsWith('/retry'))).toBe(true));
  fireEvent.click(screen.getByRole('button',{name:'품번 고치기'}));fireEvent.change(screen.getByRole('textbox',{name:'품번 고치기 · 받은 값 ABW-100'}),{target:{value:'abw101'}});fireEvent.click(screen.getByRole('button',{name:'저장'}));
  await waitFor(()=>expect(mocks.api.mock.calls.find(([p])=>p.endsWith('/fix-code'))?.[2]).toEqual({productCode:'ABW-101'}));
  fireEvent.click(screen.getByRole('button',{name:'SSIS-001 버리기'}));expect(await screen.findByRole('dialog',{name:'SSIS-001 후보를 버릴까요?'})).toBeTruthy();
});
it('keeps cached rows offline and disables actions',async()=>{
  const rendered=view();await screen.findByRole('button',{name:'후보 보기'});rendered.unmount();offline=true;view();
  expect(await screen.findByText('서버에 연결되지 않음 · 마지막으로 받은 목록')).toBeTruthy();
  expect(screen.getByRole('button',{name:'후보 보기'})).toBeDisabled();expect(screen.getByRole('button',{name:'SSIS-001 버리기'})).toBeDisabled();
});
it('walks candidates after Later and Apply without a toast',async()=>{
  list=[inboxFixture.inbox,second];view();fireEvent.click(await screen.findByRole('button',{name:'후보 차례로 보기 2'}));
  await screen.findByRole('textbox',{name:'이름'});fireEvent.click(screen.getByRole('button',{name:'나중에'}));
  await waitFor(()=>expect(screen.getByRole('dialog',{name:'AV 후보 ABW-100'})).toHaveTextContent('ABW-100'));
  fireEvent.click(screen.getByRole('button',{name:'만들기'}));await waitFor(()=>expect(readInboxPlans()[0]?.id).toBe(second.id));
  expect(screen.queryByRole('textbox',{name:'이름'})).toBeNull();expect(screen.queryByText(/적용했어요/)).toBeNull();
});
const chooser=(detail=inboxFixture,state=inboxAuthority)=>render(<AvInboxChooser detail={detail} authority={state} items={[]} disabled={false} onClose={vi.fn()} onLater={vi.fn()} onApplied={vi.fn()} onReject={vi.fn()}/>);
const details_=()=>{fireEvent.click(screen.getByRole('button',{name:'자세히'}));};
it('defaults new work to code and available candidate surfaces, shows editable Korean and fixed Japanese names',()=>{
  chooser();expect(screen.getByRole('textbox',{name:'이름'})).toHaveValue('SSIS-001');
  expect(screen.getByRole('radio',{name:/새 컬렉션/})).toHaveAttribute('aria-checked','true');
  expect(screen.queryByRole('button',{name:'원제로 채우기'})).toBeNull();
  for(const name of ['앞표지','책등','뒤표지'])expect(screen.getByRole('button',{name:`${name}: 후보 사용`})).toBeTruthy();
  details_();
  expect(screen.getByRole('checkbox',{name:'원제 적용'})).toBeChecked();expect(screen.getByRole('checkbox',{name:'시리즈 적용'})).toBeDisabled();expect(screen.getByRole('textbox',{name:'女優 한국어 이름'})).toHaveValue('배우');
});
it('keeps manual cover/nonempty fields and shows already linked people without controls',()=>{
  const work={...inboxWork,avCredits:[{personId:'person',role:'performer' as const,order:0,creditName:null}]};const state={...inboxAuthority,works:[work],artworks:[{workId:'work',artworkId:'manual',kind:'cover',provider:'local-manual',providerImageId:null}],people:[{personId:'person',nameJa:'女優',displayName:'기존 배우'}]};
  chooser({...inboxFixture,matches:[{libraryId:inboxIdentity.libraryId,workId:'work',name:'내 컬렉션',entityRevision:4}]},state);
  expect(screen.getByRole('button',{name:'앞표지: 지금 것 유지'})).toBeTruthy();
  fireEvent.click(screen.getByRole('button',{name:'앞표지: 지금 것 유지'}));
  const keep=screen.getByRole('radio',{name:/지금 것 유지/});expect(keep).toHaveAttribute('aria-checked','true');expect(keep).toHaveTextContent('직접 고름');
  fireEvent.click(screen.getByRole('button',{name:'닫기'}));
  details_();
  expect(screen.getByRole('checkbox',{name:'발매일 적용'})).not.toBeChecked();expect(screen.getAllByText('다름').length).toBeGreaterThan(0);expect(screen.getByText(/이미 연결됨/)).toBeTruthy();expect(screen.queryByRole('checkbox',{name:'女優 넣기'})).toBeNull();
});
it('requires explicit target for several matches and offers a new work',()=>{
  chooser({...inboxFixture,matches:[{libraryId:inboxIdentity.libraryId,workId:'a',name:'첫 컬렉션',entityRevision:1},{libraryId:inboxIdentity.libraryId,workId:'b',name:'둘째 컬렉션',entityRevision:1}]});
  expect(screen.getByRole('button',{name:'적용'})).toBeDisabled();expect(screen.getByText('넣을 곳을 고르세요')).toBeTruthy();
  fireEvent.click(screen.getByRole('radio',{name:/새 컬렉션/}));expect(screen.getByRole('button',{name:'만들기'})).not.toBeDisabled();
});
it('offers the spine of a spine-less wide jacket, taken from the DVD cover',()=>{
  chooser({...inboxFixture,candidate:{...inboxFixture.candidate!,jacketWidth:2184,jacketHeight:1638,defaultSplit:{x1:1092,x2:1092,isWrap:true,useSpine:true}}});
  const spine=screen.getByRole('button',{name:'책등: 후보 사용'});expect(spine).toHaveTextContent('DVD');expect(spine).not.toBeDisabled();
  fireEvent.click(spine);expect(screen.getByRole('radio',{name:/DVD 표지의 책등/})).toHaveAttribute('aria-checked','true');
});
it('starts a spine the server did not find as none, and privacy requests no jackets/covers',async()=>{
  localStorage.setItem(PRIVACY_MODE_KEY,'1');chooser({...inboxFixture,candidate:{...inboxFixture.candidate!,defaultSplit:{...inboxFixture.candidate!.defaultSplit,useSpine:false}}});
  const spine=screen.getByRole('button',{name:'책등: 비움'});fireEvent.click(spine);
  expect(screen.getByRole('radio',{name:/비우기/})).toHaveAttribute('aria-checked','true');
  await waitFor(()=>expect(mocks.native).not.toHaveBeenCalled());expect(screen.queryByAltText(/펼친 재킷/)).toBeNull();
});
it('moves a cut line on the tablet and applies with those lines',()=>{
  chooser();const line=screen.getByRole('slider',{name:'뒤표지와 책등 사이 선'});
  fireEvent.keyDown(line,{key:'ArrowLeft',shiftKey:true});expect(line).toHaveAttribute('aria-valuenow','368');
  fireEvent.click(screen.getByRole('button',{name:'만들기'}));
  expect(readInboxPlans()[0].choices.split).toEqual({x1:368,x2:422});
});
it('reopens a stopped chooser with choices kept',()=>{
  const plan=createInboxPlan(inboxFixture,inboxAuthority,initialChoices(inboxFixture,null));plan.state='blocked';plan.choices.name='내 선택';
  const key=Object.keys(localStorage).find(k=>k.startsWith('lakomics.av-inbox.apply.v1.'))!;localStorage.setItem(key,JSON.stringify([plan]));chooser();expect(screen.getByRole('textbox',{name:'이름'})).toHaveValue('내 선택');
});
it('advances immediately to the next candidate after Apply',async()=>{
  list=[inboxFixture.inbox,second];view();fireEvent.click(await screen.findByRole('button',{name:'후보 차례로 보기 2'}));
  await screen.findByRole('textbox',{name:'이름'});fireEvent.click(screen.getByRole('button',{name:'만들기'}));
  await waitFor(()=>expect(screen.getByRole('dialog',{name:'AV 후보 ABW-100'})).toHaveTextContent('ABW-100'));
  expect(readInboxPlans()[0].id).toBe(inboxFixture.inbox.id);
});
it('dismisses a row without a candidate immediately and requests no confirm dialog',async()=>{
  list=[{...second,status:'not_found'}];view();fireEvent.click(await screen.findByRole('button',{name:'ABW-100 버리기'}));
  await waitFor(()=>expect(mocks.api.mock.calls.some(([p])=>p.endsWith('/dismiss'))).toBe(true));
  expect(screen.queryByRole('dialog',{name:/후보를 버릴까요/})).toBeNull();
});
it('does not choose one of several people with the same Japanese name silently',()=>{
  chooser(inboxFixture,{...inboxAuthority,people:[{personId:'p1',displayName:'첫 배우',nameJa:'女優'},{personId:'p2',displayName:'둘째 배우',nameJa:'女優'}]});
  details_();
  expect(screen.getByRole('button',{name:'女優 인물 연결'})).toHaveTextContent('새 인물');
  fireEvent.change(screen.getByRole('textbox',{name:'女優 한국어 이름'}),{target:{value:''}});
  expect(screen.getByRole('button',{name:'만들기'})).toBeDisabled();
});
it('does not flash an empty inbox while the first list is still loading',async()=>{
  let resolve!:(value:unknown)=>void;const base=mocks.api.getMockImplementation()!;
  mocks.api.mockImplementation((...args)=>args[0].startsWith('/v1/av-inbox?')?new Promise(done=>{resolve=done;}):base(...args));
  view();expect(screen.queryByText('받은 품번 없음')).toBeNull();
  resolve({items:[],hasMore:false,nextBefore:null});expect(await screen.findByText('받은 품번 없음')).toBeTruthy();
});
it('keeps the old candidate while walking loads and does not reopen after the user closes it',async()=>{
  list=[inboxFixture.inbox,second];view();fireEvent.click(await screen.findByRole('button',{name:'후보 차례로 보기 2'}));
  await screen.findByRole('textbox',{name:'이름'});
  let resolve!:(value:unknown)=>void;const base=mocks.api.getMockImplementation()!;
  mocks.api.mockImplementation((...args)=>args[0]===`/v1/av-inbox/${second.id}`?new Promise(done=>{resolve=done;}):base(...args));
  fireEvent.click(screen.getByRole('button',{name:'나중에'}));
  expect(screen.getByRole('dialog',{name:'AV 후보 SSIS-001'})).toHaveTextContent('SSIS-001');
  expect(screen.getByRole('button',{name:'나중에'})).toBeDisabled();
  fireEvent.click(screen.getByRole('button',{name:'AV 후보 SSIS-001 닫기'}));
  resolve(details[second.id]);
  await waitFor(()=>expect(screen.queryByRole('dialog',{name:/AV 후보/})).toBeNull());
});
it('keeps a durable pending acknowledgement visible when the server list no longer has the item',async()=>{
  const plan=createInboxPlan(inboxFixture,inboxAuthority,initialChoices(inboxFixture,null));plan.state='waiting';
  const key=Object.keys(localStorage).find(k=>k.startsWith('lakomics.av-inbox.apply.v1.'))!;localStorage.setItem(key,JSON.stringify([plan]));
  list=[];view();expect(await screen.findByText('확인 기다리는 중',{selector:'.ui-badge'})).toBeTruthy();
  expect(screen.getByRole('button',{name:'받은 품번 1',hidden:true})).toBeTruthy();
});

function stoppedPlan(){
  const plan=createInboxPlan(inboxFixture,inboxAuthority,initialChoices(inboxFixture,null));plan.state='blocked';plan.error='다른 기기의 변경과 겹침';
  const key=Object.keys(localStorage).find(k=>k.startsWith('lakomics.av-inbox.apply.v1.'))!;
  localStorage.setItem(key,JSON.stringify([plan]));return plan;
}
it('shows apply cancellation, disables discard and returns a stopped row to candidate available',async()=>{
  stoppedPlan();view();fireEvent.click(await screen.findByRole('button',{name:'적용 취소'}));
  expect(readInboxPlans()).toEqual([]);expect(await screen.findByRole('button',{name:'후보 보기'})).toBeTruthy();
  expect(screen.getByText('후보 있음',{selector:'.ui-badge'})).toBeTruthy();
});
it('disables rejection while rechecking a stopped plan',()=>{
  stoppedPlan();chooser();expect(screen.getByRole('button',{name:'거절'})).toBeDisabled();expect(screen.getByRole('status')).toHaveTextContent('다시 확인함 · 바뀐 항목 없음');
});
it('keeps a dismissed stopped item visible with only apply cancellation',async()=>{
  stoppedPlan();list=[{...inboxFixture.inbox,status:'dismissed'}];details[inboxFixture.inbox.id]={...inboxFixture,candidate:null};view();
  expect(await screen.findByRole('button',{name:'적용 취소'})).toBeTruthy();expect(screen.queryByRole('button',{name:'다시 확인'})).toBeNull();
  expect(screen.getByText('멈춤',{selector:'.ui-badge'})).toBeTruthy();fireEvent.click(screen.getByRole('button',{name:'적용 취소'}));
  expect(await screen.findByText('받은 품번 없음')).toBeTruthy();
});
it('turns a candidate lost during recheck into cancellation only',async()=>{
  stoppedPlan();view();const recheck=await screen.findByRole('button',{name:'다시 확인'});
  details[inboxFixture.inbox.id]={...inboxFixture,candidate:null};fireEvent.click(recheck);
  await waitFor(()=>expect(screen.queryByRole('button',{name:'다시 확인'})).toBeNull());expect(screen.getByRole('button',{name:'적용 취소'})).toBeTruthy();
});
it('offers retry for a pending server acknowledgement and clears its backoff',async()=>{
  const plan=stoppedPlan();plan.state='waiting';plan.nextAttemptAt=Date.now()+600000;
  const key=Object.keys(localStorage).find(k=>k.startsWith('lakomics.av-inbox.apply.v1.'))!;localStorage.setItem(key,JSON.stringify([plan]));
  view();fireEvent.click(await screen.findByRole('button',{name:'다시 시도'}));expect(readInboxPlans()[0].nextAttemptAt).toBe(0);
  expect(screen.getByText('확인 기다리는 중',{selector:'.ui-badge'})).toBeTruthy();
});
it('offers an unfinished matching work rather than defaulting to another new collection',()=>{
  const plan=createInboxPlan(inboxFixture,inboxAuthority,initialChoices(inboxFixture,null));
  chooser({...inboxFixture,inbox:{...inboxFixture.inbox,id:'pending-target'}});
  expect(screen.getByRole('radio',{name:/SSIS-001/})).toHaveAttribute('aria-checked','true');expect(screen.queryByRole('textbox',{name:'이름'})).toBeNull();
  fireEvent.click(screen.getByRole('button',{name:'적용'}));expect(readInboxPlans().find(p=>p.id==='pending-target')?.workId).toBe(plan.workId);
});
it('requires a target when multiple local pending works match',()=>{
  const plan=createInboxPlan(inboxFixture,inboxAuthority,initialChoices(inboxFixture,null));
  const key=Object.keys(localStorage).find(k=>k.startsWith('lakomics.av-inbox.apply.v1.'))!;
  localStorage.setItem(key,JSON.stringify([plan,{...plan,id:'another-plan',workId:'another-work'}]));
  chooser({...inboxFixture,inbox:{...inboxFixture.inbox,id:'pending-target'}});
  expect(screen.getByRole('button',{name:'적용'})).toBeDisabled();expect(screen.getAllByRole('radio').length).toBe(3);expect(screen.getByText('넣을 곳을 고르세요')).toBeTruthy();
});
it('shows a refreshed manual cover and filled field as keep instead of restoring the old overwrite choice',()=>{
  const state={...inboxAuthority,works:[inboxWork]};const plan=createInboxPlan(inboxFixture,state,initialChoices(inboxFixture,inboxWork));
  plan.state='blocked';plan.choices.surfaces.front='candidate';plan.choices.fields.releaseDate='2025-01-01';
  const key=Object.keys(localStorage).find(k=>k.startsWith('lakomics.av-inbox.apply.v1.'))!;localStorage.setItem(key,JSON.stringify([plan]));
  chooser(inboxFixture,{...state,works:[{...inboxWork,selection:{work:'new-manual'},details:{av:{...inboxWork.details.av,releaseDate:'2026-01-01'}}}]});
  expect(screen.getByRole('button',{name:'앞표지: 지금 것 유지'})).toBeTruthy();
  details_();expect(screen.getByRole('checkbox',{name:'발매일 적용'})).not.toBeChecked();expect(screen.getByRole('status')).toHaveTextContent('앞표지의 현재 선택 · 출시일 바뀜');
});

it('shows a paused inbox in the per-work queue with a Korean reason and cancellation',()=>{
  const plan=stoppedPlan();render(<AuthorityQueue authority={{...authority,rows:[]} as ReturnType<typeof useCollectionAuthority>} workId={plan.workId} onForm={vi.fn()}/>);
  expect(screen.getByText('멈춤')).toBeTruthy();expect(screen.getByText('받은 품번 · 다른 기기의 변경과 겹침')).toBeTruthy();
  fireEvent.click(screen.getByRole('button',{name:'적용 취소'}));expect(readInboxPlans()).toEqual([]);
});

it('downloads no row thumbnails while privacy mode is enabled',async()=>{
  localStorage.setItem(PRIVACY_MODE_KEY,'1');view();await screen.findByRole('button',{name:'후보 보기'});
  await waitFor(()=>expect(mocks.native).not.toHaveBeenCalled());expect(screen.queryByRole('img')).toBeNull();
});
it('keeps a pending performer linked instead of creating another person for a second inbox candidate',()=>{
  createInboxPlan(inboxFixture,inboxAuthority,initialChoices(inboxFixture,null));
  chooser({...inboxFixture,inbox:{...inboxFixture.inbox,id:'second-with-person'}});
  details_();expect(screen.getByText(/이미 연결됨/)).toBeTruthy();expect(screen.queryByRole('checkbox',{name:'女優 넣기'})).toBeNull();
  fireEvent.click(screen.getByRole('button',{name:'적용'}));expect(readInboxPlans().find(p=>p.id==='second-with-person')?.choices.people[0].action).toBe('link');
});

it('offers only people credited as a performer, including people credited in both, and ignores directors',()=>{
  const detail={...inboxFixture,candidate:{...inboxFixture.candidate!,directors:[{nameJa:'監督',nameKo:'감독 후보',wikidataId:null,fanzaActressId:null}]}};
  const people=[{personId:'actor',displayName:'출연 전용',nameJa:'女優'},{personId:'director',displayName:'감독 전용',nameJa:'女優'},{personId:'both',displayName:'겸업',nameJa:'兼業'},{personId:'none',displayName:'이력 없음',nameJa:null}];
  const avCredits=[{personId:'actor',role:'performer' as const,order:0},{personId:'director',role:'director' as const,order:0},{personId:'both',role:'performer' as const,order:1},{personId:'both',role:'director' as const,order:1}];
  chooser(detail,{...inboxAuthority,people,works:[{...inboxWork,details:{av:{productCode:'OTHER-1',genres:[]}},avCredits}]});
  details_();
  expect(screen.queryByRole('button',{name:'監督 인물 연결'})).toBeNull();expect(screen.queryByRole('textbox',{name:'監督 한국어 이름'})).toBeNull();
  const link=screen.getByRole('button',{name:'女優 인물 연결'});expect(link).toHaveTextContent('기존 인물');
  expect(screen.getByRole('textbox',{name:'女優 한국어 이름'})).toHaveValue('출연 전용');
  fireEvent.click(link);
  const results=within(screen.getByRole('listbox',{name:'女優 기존 인물 결과'}));
  expect(results.getAllByRole('option').map(o=>o.textContent)).toEqual(['출연 전용女優','겸업兼業']);
  fireEvent.click(results.getByRole('option',{name:/겸업/}));
  expect(screen.getByRole('textbox',{name:'女優 한국어 이름'})).toHaveValue('겸업');
  fireEvent.click(screen.getByRole('button',{name:'女優 인물 연결'}));fireEvent.click(screen.getByRole('button',{name:'새 인물로'}));
  expect(screen.getByRole('textbox',{name:'女優 한국어 이름'})).toHaveValue('배우');expect(screen.getByRole('textbox',{name:'女優 한국어 이름'})).toBeEnabled();
});
it('does not automatically link a director-only match to a performer',()=>{
  chooser(inboxFixture,{...inboxAuthority,people:[{personId:'director',displayName:'감독',nameJa:'女優'}],works:[{...inboxWork,details:{av:{productCode:'OTHER-1',genres:[]}},avCredits:[{personId:'director',role:'director',order:0}]}]});
  details_();
  expect(screen.getByRole('button',{name:'女優 인물 연결'})).toHaveTextContent('새 인물');
  expect(screen.getByRole('textbox',{name:'女優 한국어 이름'})).toBeEnabled();
});
it('shows genres by Korean name without sale tags and never plans a hidden tag or a director',()=>{
  const detail={...inboxFixture,candidate:{...inboxFixture.candidate!,fields:{...inboxFixture.candidate!.fields,genres:['痴女','セール対象商品','ハイビジョン']},directors:[{nameJa:'監督',nameKo:null,wikidataId:null,fanzaActressId:null}]}};
  chooser(detail);details_();
  expect(screen.getByRole('button',{name:'치녀'})).toHaveAttribute('aria-pressed','true');expect(screen.queryByText('セール対象商品')).toBeNull();expect(screen.getByText('판매·샘플 태그 2개 숨김')).toBeTruthy();
  fireEvent.click(screen.getByRole('button',{name:'만들기'}));
  const plan=readInboxPlans()[0]!;expect(plan.choices.fields.genres).toEqual(['痴女']);expect(plan.choices.people.map(p=>p.role)).toEqual(['performer']);
});

it('keeps the old jacket until the alternative loads and saves the selected key',async()=>{
  const detail=structuredClone(inboxFixture),candidate=detail.candidate!;
  candidate.jackets=[
    {key:'wrap',url:'',width:800,height:538,hasSpine:true,chosen:true,sha256:candidate.jacketSha256!,defaultSplit:candidate.defaultSplit},
    {key:'digital',url:'',width:2184,height:1638,hasSpine:true,chosen:false,sha256:'b'.repeat(64),defaultSplit:{x1:1092,x2:1092,isWrap:true,useSpine:true},spineSource:{width:800,height:538,x1:378,x2:422}},
  ];
  chooser(detail);
  await waitFor(()=>expect(screen.getByRole('img',{name:'SSIS-001 펼친 재킷'})).toBeVisible());
  const old=screen.getByRole('img',{name:'SSIS-001 펼친 재킷'});
  fireEvent.click(screen.getByRole('button',{name:'다른 표지'}));
  await waitFor(()=>expect(mocks.native.mock.calls.some(([,body])=>body.path.endsWith('/jacket?jacketKey=digital'))).toBe(true));
  fireEvent.click(screen.getByRole('button',{name:'표지 2'}));
  await waitFor(()=>expect(screen.getAllByAltText('SSIS-001 펼친 재킷')).toHaveLength(2));
  const next=screen.getAllByAltText('SSIS-001 펼친 재킷').find(image=>image!==old)!;
  expect(old).toBeVisible();expect(next).not.toBeVisible();
  fireEvent.load(next);await waitFor(()=>expect(next).toBeVisible());expect(old).not.toBeInTheDocument();
  fireEvent.click(screen.getByRole('button',{name:'만들기'}));
  expect(readInboxPlans()[0]).toMatchObject({choices:{jacketKey:'digital',split:{x1:1092,x2:1093}},reviewedJacketSha256:'b'.repeat(64)});
});
it('relooks up found items from the chooser',async()=>{
  chooser();fireEvent.click(screen.getByRole('button',{name:'다시 찾기'}));
  await waitFor(()=>expect(mocks.api.mock.calls.some(([path])=>path.endsWith('/retry'))).toBe(true));
});
