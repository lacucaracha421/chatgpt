import {beforeEach,expect,it,vi} from 'vitest';
import {setOutboxConnection} from './outboxConnection';
const mocks=vi.hoisted(()=>({api:vi.fn(),native:vi.fn()}));
vi.mock('./transport',async()=>({...await vi.importActual<typeof import('./transport')>('./transport'),api:mocks.api,native:mocks.native}));
import {ApiError} from './transport';
import {composeInboxCommands,createInboxPlan,initialChoices,readInboxPlans,resumeInboxApplies,cancelInboxPlan,inboxWorks,inboxMatches,refreshedChoices,retryInboxPlan} from './avInboxApply';
import {AUTHORITY_STATUS_PATH,COMMAND_PATH,flushCommands,readCommands,reconcileCommands} from './collectionCommandOutbox';
import {inboxAuthority,inboxFixture,inboxIdentity,inboxWork,manifest} from './avInboxFixtures';
import type {InboxAuthority} from './avInbox';
let authority:InboxAuthority;
beforeEach(()=>{localStorage.clear();setOutboxConnection('https://test.example');mocks.api.mockReset();mocks.native.mockResolvedValue({url:'data:image/jpeg;base64,YQ=='});authority=structuredClone(inboxAuthority);
  mocks.api.mockImplementation(async(path:string,_signal:unknown,body:Record<string,unknown>)=>{
    if(path===AUTHORITY_STATUS_PATH)return {...inboxIdentity,active:true};
    if(path.includes('/baseline')){const section=new URL(`https://test.example${path}`).searchParams.get('section');return {...inboxIdentity,snapshotCursor:10,items:section?authority[section as 'works'|'people'|'artworks']:[],hasMore:false,nextAfter:null};}
    if(path===`/v1/av-inbox/${inboxFixture.inbox.id}`)return structuredClone(inboxFixture);
    if(path.endsWith('/artwork'))return {items:(body.surfaces as ('front'|'spine'|'back')[]).map(manifest)};
    if(path===COMMAND_PATH)return {...body,changed:true};
    if(path.endsWith('/applied'))return {inbox:{...inboxFixture.inbox,status:'applied'}};
    throw new Error(path);
  });
});
const pass=async()=>{await resumeInboxApplies(inboxIdentity);await flushCommands();await resumeInboxApplies(inboxIdentity);};
it('composes create, surfaces, field CAS and preserved/new credits with exact revisions',()=>{
  const choices=initialChoices(inboxFixture,null),plan=createInboxPlan(inboxFixture,authority,choices);plan.manifests=['front','spine','back'].map(s=>manifest(s as 'front'|'spine'|'back'));
  const commands=composeInboxCommands(plan);
  expect(commands.map(c=>c.commandType)).toEqual(['createWork','addArtwork','selectArtwork','addArtwork','selectArtwork','addArtwork','selectArtwork','setAvDetails','setAvCredits']);
  expect(commands[7]).toMatchObject({changes:{productCode:'SSIS-001'},expected:{productCode:null}});
  expect(commands[8]).toMatchObject({expectedRevision:5,people:[{nameJa:'女優',displayName:'배우'}]});
  expect(commands.filter(c=>c.commandType==='addArtwork').every(c=>!('surface' in c))).toBe(true);
});
it('keeps manual artwork, sends only chosen surfaces, fills blank code and preserves existing credits',async()=>{
  const base={...inboxWork,details:{av:{genres:[]}},avCredits:[{personId:'old',role:'performer' as const,order:0,creditName:null}]};authority.works=[base];
  const choices=initialChoices(inboxFixture,base);choices.surfaces.spine='keep';choices.people[0].action='link';choices.people[0].personId='known';
  createInboxPlan(inboxFixture,authority,choices);await pass();await pass();
  expect(mocks.api.mock.calls.find(([p])=>p.endsWith('/artwork'))?.[2]).toMatchObject({x1:378,x2:422,surfaces:['back']});
  const sent=mocks.api.mock.calls.filter(([p])=>p===COMMAND_PATH).map(([, ,b])=>b);
  expect(sent.find(c=>c.commandType==='selectArtwork')).toMatchObject({slot:'back',expectedArtworkId:null});
  expect(sent.find(c=>c.commandType==='setAvCredits')).toMatchObject({expectedRevision:6,credits:[{personId:'old'},{personId:'known'}],people:[]});
  expect(readInboxPlans()[0].state).toBe('done');
});
it('persists a durable plan before preparation, resumes identical IDs and acknowledges only after acceptance',async()=>{
  const plan=createInboxPlan(inboxFixture,authority,initialChoices(inboxFixture,null));expect(readInboxPlans()[0].workId).toBe(plan.workId);
  await resumeInboxApplies(inboxIdentity);const ids=readCommands().map(r=>r.command.operationId);expect(mocks.api.mock.calls.some(([p])=>p.endsWith('/applied'))).toBe(false);
  await resumeInboxApplies(inboxIdentity);expect(readCommands().map(r=>r.command.operationId)).toEqual(ids);
  await flushCommands();await resumeInboxApplies(inboxIdentity);expect(readInboxPlans()[0].state).toBe('sending');
  await flushCommands();await resumeInboxApplies(inboxIdentity);expect(readInboxPlans()[0].state).toBe('done');
  expect(mocks.api.mock.calls.filter(([p])=>p.endsWith('/artwork'))).toHaveLength(1);
  expect(new Set(mocks.api.mock.calls.filter(([p])=>p===COMMAND_PATH).map(([, ,b])=>b.operationId)).size).toBe(9);
});
it('keeps 404 acknowledgement pending with backoff and never reapplies accepted commands',async()=>{
  const base=mocks.api.getMockImplementation()!;let unavailable=true;
  mocks.api.mockImplementation(async(...args)=>args[0].endsWith('/applied')&&unavailable?Promise.reject(new ApiError('없음',404,{detail:{code:'avInboxNotFound'}})):base(...args));
  createInboxPlan(inboxFixture,authority,initialChoices(inboxFixture,null));await pass();await pass();
  expect(readInboxPlans()[0]).toMatchObject({state:'waiting',attempts:1});const sends=mocks.api.mock.calls.filter(([p])=>p===COMMAND_PATH).length;
  await pass();expect(mocks.api.mock.calls.filter(([p])=>p.endsWith('/applied'))).toHaveLength(1);
  unavailable=false;vi.spyOn(Date,'now').mockReturnValue(Date.now()+16000);await pass();vi.restoreAllMocks();
  expect(readInboxPlans()[0].state).toBe('done');expect(mocks.api.mock.calls.filter(([p])=>p===COMMAND_PATH)).toHaveLength(sends);
});
it('treats acknowledgement state conflict as done elsewhere',async()=>{
  const base=mocks.api.getMockImplementation()!;mocks.api.mockImplementation(async(...args)=>args[0].endsWith('/applied')?Promise.reject(new ApiError('다른 기기',409,{detail:{code:'avInboxStateConflict'}})):base(...args));
  createInboxPlan(inboxFixture,authority,initialChoices(inboxFixture,null));await pass();await pass();expect(readInboxPlans()[0].state).toBe('done');
});
it('stops dependents on conflict and retains choices and partial accepted progress',async()=>{
  const base=mocks.api.getMockImplementation()!;mocks.api.mockImplementation(async(...args)=>args[0]===COMMAND_PATH&&args[2].commandType==='selectArtwork'?Promise.reject(new ApiError('겹침',409,{detail:{code:'artworkConflict'}})):base(...args));
  createInboxPlan(inboxFixture,authority,initialChoices(inboxFixture,null));await pass();
  expect(readInboxPlans()[0]).toMatchObject({state:'blocked',choices:{surfaces:{front:'candidate'}}});
  expect(mocks.api.mock.calls.filter(([p])=>p===COMMAND_PATH).map(([, ,b])=>b.commandType)).toEqual(['createWork','addArtwork','selectArtwork']);
  expect(mocks.api.mock.calls.some(([p])=>p.endsWith('/applied'))).toBe(false);
});
it('refuses a different nonempty code and scopes durable plans to the connection',()=>{
  authority.works=[{...inboxWork,details:{av:{productCode:'ABW-100'}}}];
  expect(()=>createInboxPlan(inboxFixture,authority,initialChoices(inboxFixture,authority.works[0]))).toThrow('품번이 다른 컬렉션');
  createInboxPlan(inboxFixture,inboxAuthority,initialChoices(inboxFixture,null));setOutboxConnection('https://other.example');expect(readInboxPlans()).toEqual([]);
});
it('uses receipted no-op effects for credit revision and pins accepted operations until ack',async()=>{
  const base=mocks.api.getMockImplementation()!;mocks.api.mockImplementation(async(...args)=>args[0]===COMMAND_PATH?{...args[2],changed:args[2].commandType!=='setAvDetails'}:base(...args));
  createInboxPlan(inboxFixture,authority,initialChoices(inboxFixture,null));await pass();
  reconcileCommands(inboxIdentity,{id:readInboxPlans()[0].workId,type:'av',name:'SSIS-001',showcase:false});expect(readCommands()).toHaveLength(9);
  await pass();expect(mocks.api.mock.calls.find(([p,,b])=>p===COMMAND_PATH&&b.commandType==='setAvCredits')?.[2]).toMatchObject({expectedRevision:4});
});
it('reads supported baseline sections and collects AV people embedded in works',async()=>{
  authority.works=[{...inboxWork,avPeople:[{personId:'known',displayName:'배우',nameJa:'女優'}]}];
  const {readInboxAuthority}=await import('./avInbox');const state=await readInboxAuthority(inboxIdentity);
  expect(state.people).toEqual(authority.works[0].avPeople);
  expect(mocks.api.mock.calls.filter(([p])=>p.includes('section=')).map(([p])=>new URL('https://test.example'+p).searchParams.get('section'))).toEqual(['works','artworks']);
});
it('waits for preceding FIFO changes and composes from their accepted authority state',async()=>{
  authority.works=[structuredClone(inboxWork)];
  const {enqueueCommand}=await import('./collectionCommandOutbox');
  enqueueCommand(inboxIdentity,{commandType:'setAvDetails',workId:'work',changes:{maker:'Earlier maker'},expected:{maker:null}});
  const {predictedInboxWork}=await import('./avInboxApply');
  const predicted=predictedInboxWork(authority.works[0],authority,inboxFixture.inbox.id);
  const plan=createInboxPlan(inboxFixture,authority,initialChoices(inboxFixture,predicted));
  await resumeInboxApplies(inboxIdentity);expect(mocks.api.mock.calls.some(([p])=>p.endsWith('/artwork'))).toBe(false);
  await flushCommands();authority.works[0]={...predicted,entityRevision:5};await resumeInboxApplies(inboxIdentity);
  expect(readInboxPlans()[0].base?.entityRevision).toBe(5);
  expect(readInboxPlans()[0].workId).toBe(plan.workId);
  expect(readInboxPlans()[0].commands.filter(c=>c.commandType==='setAvDetails').every(c=>!('maker' in c.changes))).toBe(true);
});
it('strips published credit display fields before sending a complete desired credit list',async()=>{
  authority.works=[{...inboxWork,avCredits:[{personId:'old',role:'performer',order:0,creditName:null,name:'Old name',nameJa:'以前'} as unknown as typeof inboxWork.avCredits[number]]}];
  const {readInboxAuthority}=await import('./avInbox');const read=await readInboxAuthority(inboxIdentity);
  expect(Object.keys(read.works[0].avCredits[0]).sort()).toEqual(['creditName','order','personId','role']);
  const choices=initialChoices(inboxFixture,read.works[0]);createInboxPlan(inboxFixture,read,choices);await pass();await pass();
  const body=mocks.api.mock.calls.find(([p,,b])=>p===COMMAND_PATH&&b.commandType==='setAvCredits')?.[2];
  expect(Object.keys(body.credits[0]).sort()).toEqual(['creditName','order','personId','role']);
});
it('does not start preparation when durable plan storage fails',()=>{
  vi.spyOn(Storage.prototype,'setItem').mockImplementation(()=>{throw new Error('full');});
  expect(()=>createInboxPlan(inboxFixture,authority,initialChoices(inboxFixture,null))).toThrow('full');
  expect(mocks.api).not.toHaveBeenCalled();vi.restoreAllMocks();
});
it('takes the latest receipted work revision, including earlier person edits',async()=>{
  const base=mocks.api.getMockImplementation()!;
  mocks.api.mockImplementation(async(...args)=>args[0]===COMMAND_PATH&&args[2].commandType==='setAvDetails'
    ?{...args[2],changed:true,entities:{works:[{workId:args[2].workId,entityRevision:12}]}}:base(...args));
  createInboxPlan(inboxFixture,authority,initialChoices(inboxFixture,null));await pass();await pass();
  expect(mocks.api.mock.calls.find(([p,,b])=>p===COMMAND_PATH&&b.commandType==='setAvCredits')?.[2].expectedRevision).toBe(12);
});
it('fills whitespace-only product codes using field CAS',()=>{
  const work={...inboxWork,details:{av:{productCode:'  ',genres:[]}}};authority.works=[work];
  const choices=initialChoices(inboxFixture,work);choices.surfaces={front:'keep',spine:'keep',back:'keep'};choices.people=[];
  const commands=composeInboxCommands(createInboxPlan(inboxFixture,authority,choices));
  expect(commands.find(c=>c.commandType==='setAvDetails')).toMatchObject({changes:{productCode:'SSIS-001'},expected:{productCode:'  '}});
});

function storePlans(plans:ReturnType<typeof readInboxPlans>){
  const key=Object.keys(localStorage).find(k=>k.startsWith('lakomics.av-inbox.apply.v1.'))!;
  localStorage.setItem(key,JSON.stringify(plans));
}
it('cancels only unaccepted inbox rows and releases the collection while retaining accepted and unrelated rows',async()=>{
  const base=mocks.api.getMockImplementation()!;
  mocks.api.mockImplementation(async(...args)=>args[0]===COMMAND_PATH&&args[2].commandType==='selectArtwork'?Promise.reject(new ApiError('겹침',409,{})):base(...args));
  createInboxPlan(inboxFixture,authority,initialChoices(inboxFixture,null));await pass();
  const {enqueueCommand}=await import('./collectionCommandOutbox');
  const unrelated=enqueueCommand(inboxIdentity,{commandType:'updateWork',workId:readInboxPlans()[0].workId,changes:{description:'memo'},expected:{description:null},expectedRevision:null});
  const accepted=readCommands().filter(r=>r.state==='accepted');expect(accepted).toHaveLength(2);
  cancelInboxPlan(inboxFixture.inbox.id);
  expect(readInboxPlans()).toEqual([]);expect(readCommands()).toEqual([...accepted,unrelated]);
  mocks.api.mockImplementation(base);await flushCommands();expect(readCommands().find(r=>r.command.operationId===unrelated.command.operationId)?.state).toBe('accepted');
});
it('matches unfinished inbox plans and refuses another new work for their normalized code',()=>{
  const first=createInboxPlan(inboxFixture,authority,initialChoices(inboxFixture,null));
  const detail={...inboxFixture,inbox:{...inboxFixture.inbox,id:'second',productCode:'ssis001',normalizedCode:'SSIS-001'}};
  expect(inboxMatches(detail,authority).map(m=>m.workId)).toEqual([first.workId]);
  expect(()=>createInboxPlan(detail,authority,initialChoices(detail,null))).toThrow('같은 품번의 대기 컬렉션');
  const pending=inboxWorks(authority,detail.inbox.id).find(w=>w.workId===first.workId)!;
  const next=createInboxPlan(detail,authority,initialChoices(detail,pending));
  expect(next).toMatchObject({workId:first.workId,isNew:false,dependencies:[`plan:${first.id}`]});
  expect(next.choices.surfaces).toEqual({front:'keep',spine:'keep',back:'keep'});
});
it('matches pending createWork and setAvDetails without picking among multiple works',async()=>{
  const {enqueueCommand}=await import('./collectionCommandOutbox');
  for(const workId of ['pending-a','pending-b']){
    enqueueCommand(inboxIdentity,{commandType:'createWork',workId,type:'av',name:workId,legacyKind:null,fields:{},binding:null});
    enqueueCommand(inboxIdentity,{commandType:'setAvDetails',workId,changes:{productCode:'ssis001'},expected:{productCode:null}});
  }
  expect(inboxMatches(inboxFixture,authority).map(m=>m.workId)).toEqual(['pending-a','pending-b']);
  const pending=inboxWorks(authority).find(w=>w.workId==='pending-a')!;
  const plan=createInboxPlan(inboxFixture,authority,initialChoices(inboxFixture,pending));
  expect(plan.isNew).toBe(false);expect(plan.dependencies).toHaveLength(2);
});
it('refreshes changed covers and fields, preserving only choices whose candidate and current value are unchanged',()=>{
  authority.works=[structuredClone(inboxWork)];const choices=initialChoices(inboxFixture,inboxWork);
  choices.surfaces.front='candidate';choices.fields.releaseDate='2025-01-01';delete choices.fields.maker;
  const plan=createInboxPlan(inboxFixture,authority,choices);
  const work={...inboxWork,selection:{work:'new-manual'},details:{av:{...inboxWork.details.av,maker:null,titleJa:'Other title',releaseDate:'2026-01-01'}}};
  const next=refreshedChoices(inboxFixture,work,plan);
  expect(next.surfaces.front).toBe('keep');expect(next.fields.releaseDate).toBeUndefined();expect(next.fields.titleJa).toBeUndefined();expect(next.fields.maker).toBeUndefined();
  const changed={...inboxFixture,candidate:{...inboxFixture.candidate!,fields:{...inboxFixture.candidate!.fields,maker:'New maker'}}};
  expect(refreshedChoices(changed,work,plan).fields.maker).toBe('New maker');
});
it('uses fresh artwork and person ids on recheck after a target switch or accepted ids',()=>{
  const plan=createInboxPlan(inboxFixture,authority,initialChoices(inboxFixture,null));plan.state='blocked';plan.accepted=['old'];storePlans([plan]);
  authority.works=[{...inboxWork,workId:'another'}];
  const next=createInboxPlan(inboxFixture,authority,initialChoices(inboxFixture,authority.works[0]));
  for(const surface of ['front','spine','back'] as const)expect(next.artworkIds[surface]).not.toBe(plan.artworkIds[surface]);
  expect(next.personIds['女優']).not.toBe(plan.personIds['女優']);
});
it('blocks work mismatch acknowledgement with a Korean reason instead of retrying',async()=>{
  const base=mocks.api.getMockImplementation()!;
  mocks.api.mockImplementation(async(...args)=>args[0].endsWith('/applied')?Promise.reject(new ApiError('mismatch',409,{detail:{code:'avInboxWorkMismatch'}})):base(...args));
  createInboxPlan(inboxFixture,authority,initialChoices(inboxFixture,null));await pass();await pass();
  expect(readInboxPlans()[0]).toMatchObject({state:'blocked',error:'품번이 다른 컬렉션이에요 · 다시 확인'});
  await pass();expect(mocks.api.mock.calls.filter(([p])=>p.endsWith('/applied'))).toHaveLength(1);
});
it.each(['code','jacket'])('blocks before artwork preparation when the reviewed %s changes',async what=>{
  const base=mocks.api.getMockImplementation()!;
  mocks.api.mockImplementation(async(...args)=>args[0]===`/v1/av-inbox/${inboxFixture.inbox.id}`&&what==='code'?{...inboxFixture,inbox:{...inboxFixture.inbox,normalizedCode:'ABW-100'}}:base(...args));
  if(what==='jacket')mocks.native.mockResolvedValue({url:'data:image/jpeg;base64,Yg=='});
  createInboxPlan(inboxFixture,authority,initialChoices(inboxFixture,null));await resumeInboxApplies(inboxIdentity);
  expect(readInboxPlans()[0]).toMatchObject({state:'blocked',error:'후보가 바뀌었어요 · 다시 확인'});
  expect(mocks.api.mock.calls.some(([p])=>p.endsWith('/artwork'))).toBe(false);expect(readCommands()).toEqual([]);
});
it('rejects artwork manifests for another reviewed code or jacket in composition',()=>{
  const plan=createInboxPlan(inboxFixture,authority,initialChoices(inboxFixture,null));plan.manifests=['front','spine','back'].map(s=>manifest(s as 'front'|'spine'|'back'));
  plan.manifests[0].providerImageId='SSIS-001:another-jacket:378:422:front';expect(()=>composeInboxCommands(plan)).toThrow('표지 응답');
  plan.detail.candidate!.jacketSha256='changed';expect(()=>composeInboxCommands(plan)).toThrow('후보가 바뀌었어요');
});
it('stops when a predecessor receipt has no changed effect instead of retrying forever',async()=>{
  const base=mocks.api.getMockImplementation()!;mocks.api.mockImplementation(async(...args)=>args[0]===COMMAND_PATH?args[2]:base(...args));
  createInboxPlan(inboxFixture,authority,initialChoices(inboxFixture,null));await pass();
  expect(readInboxPlans()[0]).toMatchObject({state:'blocked',error:'변경 확인 응답이 없어요 · 다시 확인'});
});
it('stops when an accepted predecessor row was lost before its receipt was saved',async()=>{
  createInboxPlan(inboxFixture,authority,initialChoices(inboxFixture,null));await resumeInboxApplies(inboxIdentity);await flushCommands();
  const plan=readInboxPlans()[0];plan.accepted=readCommands().filter(r=>r.state==='accepted').map(r=>r.command.operationId);storePlans([plan]);
  const key=Object.keys(localStorage).find(k=>k.startsWith('lakomics.collection-command-outbox'));
  // Use the exact queue key in this connection, without modifying any other stored data.
  const queueKey=key??Object.keys(localStorage).find(k=>JSON.parse(localStorage.getItem(k)??'[]')?.[0]?.command)!;
  localStorage.setItem(queueKey,JSON.stringify(readCommands().filter(r=>r.command.commandType!=='selectArtwork')));
  await resumeInboxApplies(inboxIdentity);expect(readInboxPlans()[0]).toMatchObject({state:'blocked',error:'변경 확인 응답이 없어요 · 다시 확인'});
});
it('retains active plans and only twenty compact finished plans',()=>{
  const seed=createInboxPlan(inboxFixture,authority,initialChoices(inboxFixture,null));
  const finished=Array.from({length:25},(_,i)=>({...seed,id:`finished-${i}`,state:'done' as const,doneAt:i}));storePlans([seed,...finished]);
  retryInboxPlan(seed.id); // Preparing does not change storage.
  const detail={...inboxFixture,inbox:{...inboxFixture.inbox,id:'new-code',normalizedCode:'ABW-100'}};
  createInboxPlan(detail,authority,initialChoices(detail,null));
  const plans=readInboxPlans();expect(plans.filter(p=>p.state!=='done')).toHaveLength(2);expect(plans.filter(p=>p.state==='done')).toHaveLength(20);
  expect(plans.filter(p=>p.state==='done').every(p=>p.detail.candidate===null&&p.manifests.length===0&&p.base===null)).toBe(true);
  expect(plans.some(p=>p.id==='finished-0')).toBe(false);
});
it('starts the first ack retry at base delay after preparation retries and permits an immediate retry',async()=>{
  const plan=createInboxPlan(inboxFixture,authority,initialChoices(inboxFixture,null));plan.stageAttempts={preparing:5};plan.attempts=5;storePlans([plan]);
  const base=mocks.api.getMockImplementation()!;mocks.api.mockImplementation(async(...args)=>args[0].endsWith('/applied')?Promise.reject(new ApiError('missing',404,{})):base(...args));
  const now=Date.now();vi.spyOn(Date,'now').mockReturnValue(now);await pass();await pass();
  expect(readInboxPlans()[0]).toMatchObject({state:'waiting',attempts:1,nextAttemptAt:now+15000,stageAttempts:{preparing:5,waiting:1}});
  retryInboxPlan(plan.id);expect(readInboxPlans()[0].nextAttemptAt).toBe(0);vi.restoreAllMocks();
});

it('does not resurrect a cancelled paused plan when an older preparation request finishes',async()=>{
  const base=mocks.api.getMockImplementation()!;let release!:(reply:unknown)=>void;
  mocks.api.mockImplementation((...args)=>args[0].endsWith('/artwork')?new Promise(resolve=>{release=resolve;}):base(...args));
  const plan=createInboxPlan(inboxFixture,authority,initialChoices(inboxFixture,null));
  const preparing=resumeInboxApplies(inboxIdentity);
  await vi.waitFor(()=>expect(release).toBeDefined());
  const {pauseInboxPlan}=await import('./avInboxApply');pauseInboxPlan(plan.id,{...inboxFixture,candidate:null});cancelInboxPlan(plan.id);
  release({items:['front','spine','back'].map(s=>manifest(s as 'front'|'spine'|'back'))});await preparing;
  expect(readInboxPlans()).toEqual([]);expect(readCommands()).toEqual([]);
});
it('adds to a pending inbox work after the first plan finishes without waiting on its released receipt rows',async()=>{
  const first=createInboxPlan(inboxFixture,authority,initialChoices(inboxFixture,null));await resumeInboxApplies(inboxIdentity);
  const detail={...inboxFixture,inbox:{...inboxFixture.inbox,id:'second-pending'}};
  const work=inboxWorks(authority,detail.inbox.id).find(w=>w.workId===first.workId)!;
  const choices=initialChoices(detail,work);choices.people=[];
  const next=createInboxPlan(detail,authority,choices);expect(next.dependencies).toEqual([`plan:${first.id}`]);
  await pass();await pass();
  expect(readInboxPlans().find(p=>p.id===first.id)?.state).toBe('done');
  authority.works=[{...work,entityRevision:5}];
  const base=mocks.api.getMockImplementation()!;mocks.api.mockImplementation(async(...args)=>args[0]===`/v1/av-inbox/${detail.inbox.id}`?structuredClone(detail):base(...args));
  await resumeInboxApplies(inboxIdentity);
  expect(readInboxPlans().find(p=>p.id===detail.inbox.id)?.state).toBe('done');
  expect(mocks.api.mock.calls.filter(([p,,b])=>p===COMMAND_PATH&&b.commandType==='createWork')).toHaveLength(1);
});
it('replays a missing unreceipted predecessor with the exact immutable operation id',async()=>{
  createInboxPlan(inboxFixture,authority,initialChoices(inboxFixture,null));await resumeInboxApplies(inboxIdentity);
  const before=readCommands(),missing=before.find(r=>r.command.commandType==='selectArtwork')!;
  const key=Object.keys(localStorage).find(k=>JSON.parse(localStorage.getItem(k)??'[]')?.[0]?.command)!;
  localStorage.setItem(key,JSON.stringify(before.filter(r=>r!==missing)));
  await resumeInboxApplies(inboxIdentity);
  expect(readCommands().find(r=>r.command.operationId===missing.command.operationId)?.command).toEqual(missing.command);
});

it('stores a missing candidate as stopped with cancellation-only detail during preparation',async()=>{
  const base=mocks.api.getMockImplementation()!;mocks.api.mockImplementation(async(...args)=>args[0]===`/v1/av-inbox/${inboxFixture.inbox.id}`?{...inboxFixture,candidate:null}:base(...args));
  createInboxPlan(inboxFixture,authority,initialChoices(inboxFixture,null));await resumeInboxApplies(inboxIdentity);
  expect(readInboxPlans()[0]).toMatchObject({state:'blocked',detail:{candidate:null},error:'후보가 없어졌어요 · 적용 취소해 주세요.'});expect(readCommands()).toEqual([]);
});

it('uses a new work id when rechecking switches an existing target to a new collection',()=>{
  authority.works=[structuredClone(inboxWork)];const previous=createInboxPlan(inboxFixture,authority,initialChoices(inboxFixture,inboxWork));previous.state='blocked';storePlans([previous]);
  const next=createInboxPlan(inboxFixture,authority,initialChoices(inboxFixture,null));
  expect(next.isNew).toBe(true);expect(next.workId).not.toBe(inboxWork.workId);
});
