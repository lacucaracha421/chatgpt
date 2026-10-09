import {api, ApiError} from './transport';
import {connectionOutbox, outboxConnection, outboxKey} from './outboxConnection';
import {enqueueInboxCommands, readCommands, releaseInboxCommands, discardInboxCommands, sameAuthority, type Command, type AuthorityIdentity, type WorkCommand} from './collectionCommandOutbox';
import {AV_DETAIL_FIELDS, sameAvValue, validateAvDetails, validateAvCredits, type AvCredit, type AvDetailFields, type AvDetailKey, type AvNewPerson} from './avEditModel';
import {normalizeProductCode} from './avLookup';
import {candidateHasSurface, inboxPath, reviewedInboxDetail, SURFACES, SURFACE_LABELS, type InboxAuthority, type InboxDetail, type InboxWork, type PreparedArtwork, type Surface} from './avInboxModel';

export type PersonChoice={nameJa:string;role:'performer'|'director';action:'new'|'link'|'skip';displayName:string;personId:string|null};
export type InboxChoices={workId:string|null;name:string;surfaces:Record<Surface,'candidate'|'keep'|'clear'>;fields:AvDetailFields;people:PersonChoice[]};
export type InboxPlan={id:string;runId?:string;identity:AuthorityIdentity;detail:InboxDetail;choices:InboxChoices;workId:string;isNew:boolean;base:InboxWork|null;artworkIds:Record<Surface,string>;personIds:Record<string,string>;manifests:PreparedArtwork[];commands:Command[];accepted:string[];dependencies?:string[];state:'preparing'|'sending'|'waiting'|'blocked'|'done';attempts:number;stageAttempts?:Partial<Record<'preparing'|'sending'|'waiting',number>>;reviewedCode:string;reviewedJacketSha256:string;nextAttemptAt:number;doneAt?:number;error?:string};
export const INBOX_APPLY_EVENT='lakomics-av-inbox-apply';
const KEY=connectionOutbox('lakomics.av-inbox.apply.v1');
export function readInboxPlans(connection=outboxConnection()):InboxPlan[]{
  const key=outboxKey(KEY,connection);if(!key)return [];
  try {const rows=JSON.parse(localStorage.getItem(key)??'[]');return Array.isArray(rows)?rows.filter(p=>p.id&&p.identity&&p.choices&&Array.isArray(p.commands)&&Array.isArray(p.accepted)):[];}catch{return [];}
}
function save(plan:InboxPlan,connection=outboxConnection()){
  const key=outboxKey(KEY,connection);if(!key)throw new Error('적용할 내용을 저장하지 못했습니다.');
  const rows=readInboxPlans(connection).filter(p=>p.id!==plan.id);rows.push(plan);
  const active=rows.filter(p=>p.state!=='done');
  const finished=rows.filter(p=>p.state==='done').sort((a,b)=>(b.doneAt??0)-(a.doneAt??0)).slice(0,20)
    .map(p=>({...p,detail:{...p.detail,candidate:null,matches:[]},manifests:[],commands:[],base:null}));
  localStorage.setItem(key,JSON.stringify([...active,...finished]));
  if(connection===outboxConnection())window.dispatchEvent(new Event(INBOX_APPLY_EVENT));
}
/** Cancelling never rolls back operations already accepted by the server. */
export function cancelInboxPlan(id:string){
  const plan=readInboxPlans().find(p=>p.id===id);
  if(!plan||plan.state!=='blocked')return;
  discardInboxCommands(id);
  const key=outboxKey(KEY);if(!key)throw new Error('적용 취소를 저장하지 못했습니다.');
  localStorage.setItem(key,JSON.stringify(readInboxPlans().filter(p=>p.id!==id)));
  window.dispatchEvent(new Event(INBOX_APPLY_EVENT));
}
export function pauseInboxPlan(id:string,detail?:InboxDetail){
  const plan=readInboxPlans().find(p=>p.id===id);if(!plan||plan.state==='done')return;
  plan.state='blocked';plan.error='후보가 없어졌어요 · 적용 취소해 주세요.';
  if(detail)plan.detail=detail;else plan.detail={...plan.detail,candidate:null};save(plan);
}
export function retryInboxPlan(id:string){
  const plan=readInboxPlans().find(p=>p.id===id);if(!plan||plan.state!=='waiting')return;
  plan.nextAttemptAt=0;save(plan);
}
class PlanStopped extends Error {}
export function inboxWorks(authority:InboxAuthority,inboxId?:string):InboxWork[]{
  const works=authority.works.filter(w=>w.type==='av'&&w.lifecycle==='live').map(w=>predictedInboxWork(w,authority,inboxId));
  for(const row of readCommands()){
    const c=row.command;
    if(!sameAuthority(c,authority.identity)||!!inboxId&&row.inboxId===inboxId||c.commandType!=='createWork'||c.type!=='av'||works.some(w=>w.workId===c.workId))continue;
    works.push(predictedInboxWork({workId:c.workId,type:'av',name:c.name,lifecycle:'live',entityRevision:1,selection:{},details:{av:{}},avCredits:[]},authority,inboxId));
  }
  for(const p of readInboxPlans()){
    if(p.id===inboxId||p.state==='done'||!sameAuthority(p.identity,authority.identity))continue;
    let work=works.find(w=>w.workId===p.workId);
    if(!work){work={workId:p.workId,type:'av',name:p.choices.name,lifecycle:'live',entityRevision:1,selection:{},details:{av:{}},avCredits:[]};works.push(work);}
    if(p.state!=='blocked'){
      for(const surface of SURFACES){const action=p.choices.surfaces[surface];if(action!=='keep')work.selection[surfaceSlot(surface)]=action==='candidate'?p.artworkIds[surface]:null;}
      work.details.av={...work.details.av,...p.choices.fields};
      for(const person of p.choices.people){const personId=person.action==='new'?p.personIds[person.nameJa]:person.personId;
        if(person.action!=='skip'&&personId){
          if(!work.avCredits.some(c=>c.personId===personId&&c.role===person.role))work.avCredits.push({personId,role:person.role,order:work.avCredits.filter(c=>c.role===person.role).length,creditName:null});
          if(person.action==='new'){work.avPeople??=[];if(!work.avPeople.some(p=>p.personId===personId))work.avPeople.push({personId,nameJa:person.nameJa,displayName:person.displayName});}
        }}
    }
    if(!work.details.av?.productCode)work.details.av={...work.details.av,productCode:p.reviewedCode??p.detail.inbox.normalizedCode};
  }
  return works;
}
export function inboxPeople(authority:InboxAuthority,inboxId?:string){
  const people=new Map(authority.people.map(p=>[p.personId,p]));
  for(const work of inboxWorks(authority,inboxId))for(const person of work.avPeople??[])people.set(person.personId,person);
  return [...people.values()];
}
export function inboxMatches(detail:InboxDetail,authority:InboxAuthority){
  const code=normalizeProductCode(detail.inbox.normalizedCode??detail.inbox.productCode);
  const matches=new Map(detail.matches.map(m=>[m.workId,m]));
  for(const work of inboxWorks(authority,detail.inbox.id))if(normalizeProductCode(String(work.details.av?.productCode??''))===code)
    matches.set(work.workId,{libraryId:authority.identity.libraryId,workId:work.workId,name:work.name,entityRevision:work.entityRevision});
  return [...matches.values()];
}
/** Preserve intent only when both the candidate and its destination remain unchanged. */
export function refreshedChoices(detail:InboxDetail,work:InboxWork|null,previous?:InboxPlan):InboxChoices{
  const next=initialChoices(detail,work);
  if(!previous||previous.workId!==(work?.workId??previous.workId)||previous.choices.workId!==next.workId&&!previous.isNew)return next;
  const old=previous.detail.candidate,c=detail.candidate;
  if(!old||!c)return next;
  next.name=previous.choices.name;
  for(const surface of SURFACES)if((previous.base?.selection[surfaceSlot(surface)]??null)===(work?.selection[surfaceSlot(surface)]??null)
    &&previous.reviewedJacketSha256===c.jacketSha256&&sameAvValue(old.defaultSplit,c.defaultSplit))next.surfaces[surface]=previous.choices.surfaces[surface];
  for(const {key} of AV_DETAIL_FIELDS)if(sameAvValue(old.fields[key],c.fields[key])&&sameAvValue(previous.base?.details.av?.[key]??(key==='genres'?[]:null),work?.details.av?.[key]??(key==='genres'?[]:null))){
    delete next.fields[key];if(key in previous.choices.fields)next.fields[key]=previous.choices.fields[key];
  }
  next.people=next.people.map(p=>{
    const oldPerson=previous.choices.people.find(v=>v.role===p.role&&v.nameJa===p.nameJa);
    return oldPerson&&sameAvValue(previous.base?.avCredits??[],work?.avCredits??[])&&sameAvValue((p.role==='performer'?old.performers:old.directors).find(v=>v.nameJa===p.nameJa),(p.role==='performer'?c.performers:c.directors).find(v=>v.nameJa===p.nameJa))?oldPerson:p;
  });
  return next;
}
export function inboxRecheckChanges(detail:InboxDetail,work:InboxWork|null,previous:InboxPlan):string[]{
  const changes:string[]=[];
  if(work?.workId&&work.workId!==previous.workId)changes.push('적용할 컬렉션');
  if(previous.reviewedJacketSha256!==detail.candidate?.jacketSha256)changes.push('표지 후보');
  for(const surface of SURFACES)if((previous.base?.selection[surfaceSlot(surface)]??null)!==(work?.selection[surfaceSlot(surface)]??null))changes.push(`${SURFACE_LABELS[surface]}의 현재 선택`);
  for(const {key,label} of AV_DETAIL_FIELDS)if(!sameAvValue(previous.detail.candidate?.fields[key],detail.candidate?.fields[key])
    ||!sameAvValue(previous.base?.details.av?.[key]??(key==='genres'?[]:null),work?.details.av?.[key]??(key==='genres'?[]:null)))changes.push(label);
  if(!sameAvValue(previous.base?.avCredits??[],work?.avCredits??[])||!sameAvValue(previous.detail.candidate?.performers,detail.candidate?.performers)||!sameAvValue(previous.detail.candidate?.directors,detail.candidate?.directors))changes.push('출연·감독');
  return changes;
}
export const surfaceSlot=(s:Surface)=>s==='front'?'work':s;
export function initialChoices(detail:InboxDetail,work:InboxWork|null):InboxChoices{
  const c=detail.candidate!;const fields:AvDetailFields={};
  for(const [key,value] of Object.entries(c.fields)){
    const old=work?.details.av?.[key as AvDetailKey];
    if((old==null||old===''||Array.isArray(old)&&!old.length)&&value!=null&&value!==''&&(!Array.isArray(value)||value.length))fields[key as AvDetailKey]=value;
  }
  return {workId:work?.workId??null,name:detail.inbox.normalizedCode??detail.inbox.productCode,
    surfaces:Object.fromEntries(SURFACES.map(s=>[s,work?.selection[surfaceSlot(s)]?'keep':candidateHasSurface(c,s)?'candidate':work?'keep':'clear'])) as InboxChoices['surfaces'],fields,
    people:([...c.performers.map(p=>({...p,role:'performer' as const})),...c.directors.map(p=>({...p,role:'director' as const}))]).map(p=>({nameJa:p.nameJa,role:p.role,action:'new',displayName:p.nameKo||p.nameJa,personId:null}))};
}
/** The chooser includes preceding FIFO intents over its frozen authority read. */
export function predictedInboxWork(work:InboxWork,authority:InboxAuthority,inboxId?:string):InboxWork {
  const next=structuredClone(work);
  for(const row of readCommands()) {
    const command=row.command;
    if(!sameAuthority(command,authority.identity)||command.workId!==work.workId||!!inboxId&&row.inboxId===inboxId)continue;
    const receipt=row.receipts?.[row.receipts.length-1];
    if(row.state==='accepted'&&receipt?.authorityCursor!=null&&receipt.authorityCursor<=(authority.snapshotCursor??-1))continue;
    if(command.commandType==='selectArtwork')next.selection[command.slot]=command.artworkId;
    else if(command.commandType==='setAvDetails')next.details.av={...next.details.av,...command.changes};
    else if(command.commandType==='setAvCredits')next.avCredits=command.credits;
    else if(command.commandType==='updateWork'&&typeof command.changes.name==='string')next.name=command.changes.name;
  }
  return next;
}
function sameCompositionState(a:InboxWork,b:InboxWork) {
  return SURFACES.every(s=>(a.selection[surfaceSlot(s)]??null)===(b.selection[surfaceSlot(s)]??null))
    &&AV_DETAIL_FIELDS.every(({key})=>sameAvValue(a.details.av?.[key]??(key==='genres'?[]:null),b.details.av?.[key]??(key==='genres'?[]:null)))
    &&sameAvValue(a.avCredits,b.avCredits);
}
export function createInboxPlan(detail:InboxDetail,authority:InboxAuthority,choices:InboxChoices):InboxPlan{
  if(detail.inbox.status!=='found'||!detail.candidate)throw new Error('후보를 다시 확인해 주세요.');
  const previous=readInboxPlans().find(p=>p.id===detail.inbox.id);
  if(previous&&previous.state!=='blocked'&&previous.state!=='done')throw new Error('이미 보내는 중입니다.');
  const chosen=choices.workId??(previous?.isNew&&previous.accepted.includes(previous.commands[0]?.operationId)?previous.workId:null);
  const confirmed=chosen?inboxWorks(authority,detail.inbox.id).find(w=>w.workId===chosen)??null:null;
  const base=confirmed;
  if(chosen&&!base)throw new Error('컬렉션을 다시 확인해 주세요.');
  const code=detail.inbox.normalizedCode??normalizeProductCode(detail.inbox.productCode);
  if(!code)throw new Error('품번을 확인해 주세요.');
  if(!chosen&&inboxMatches(detail,authority).some(m=>!authority.works.some(w=>w.workId===m.workId)))throw new Error('같은 품번의 대기 컬렉션이 있어요. 기존 컬렉션에 후보 추가를 선택해 주세요.');
  const oldCode=base?.details.av?.productCode;
  if(typeof oldCode==='string'&&oldCode.trim()&&normalizeProductCode(oldCode)!==code)throw new Error('품번이 다른 컬렉션');
  const preceding=readCommands().filter(r=>sameAuthority(r.command,authority.identity)&&r.command.workId===chosen&&r.inboxId!==detail.inbox.id);
  if(preceding.some(r=>r.state==='conflict'))throw new Error('이 컬렉션의 앞선 변경을 먼저 확인해 주세요.');
  validateAvDetails(choices.fields);
  if(choices.people.some(p=>p.action==='new'&&(!p.displayName.trim()||[...p.displayName.trim()].length>120)))throw new Error('인물 이름을 확인해 주세요.');
  const plan:InboxPlan={id:detail.inbox.id,runId:crypto.randomUUID(),identity:authority.identity,detail:structuredClone(detail),choices:structuredClone(choices),workId:base?.workId??(previous?.isNew?previous.workId:crypto.randomUUID()),isNew:!base,base:base?structuredClone(base):null,
    artworkIds:{front:crypto.randomUUID(),spine:crypto.randomUUID(),back:crypto.randomUUID()},personIds:{},manifests:[],commands:[],accepted:[],dependencies:[...preceding.filter(r=>r.state==='pending'&&!r.inboxId).map(r=>r.command.operationId),...readInboxPlans().filter(p=>p.id!==detail.inbox.id&&p.workId===chosen&&p.state!=='done').map(p=>`plan:${p.id}`)],state:'preparing',attempts:0,stageAttempts:{},reviewedCode:code,reviewedJacketSha256:detail.candidate.jacketSha256??'',nextAttemptAt:0};
  if(previous&&previous.state==='blocked'&&sameAvValue(previous.detail.candidate,detail.candidate))plan.manifests=previous.manifests;
  for(const p of choices.people)if(p.action==='new'&&!plan.personIds[p.nameJa])plan.personIds[p.nameJa]=crypto.randomUUID();
  // The plan must be durable before cancelling the refused sequence or preparing bytes.
  save(plan);if(previous)discardInboxCommands(plan.id);return plan;
}
export function composeInboxCommands(plan:InboxPlan,artworks:InboxAuthority['artworks']=[]):Command[]{
  const {choices,base,workId,detail}=plan,c=detail.candidate;
  if(!c||normalizeProductCode(detail.inbox.normalizedCode??detail.inbox.productCode)!==plan.reviewedCode||!plan.reviewedJacketSha256||c.jacketSha256!==plan.reviewedJacketSha256)throw new PlanStopped('후보가 바뀌었어요 · 다시 확인');
  const commands:WorkCommand[]=[];let revision=base?.entityRevision??1;
  if(plan.isNew)commands.push({commandType:'createWork',workId,type:'av',name:choices.name.trim()||detail.inbox.normalizedCode!,legacyKind:null,fields:{},binding:null});
  for(const surface of SURFACES){
    const action=choices.surfaces[surface];if(action==='keep')continue;
    const slot=surfaceSlot(surface),expectedArtworkId=base?.selection[slot]??null;let artworkId:string|null=null;
    if(action==='candidate'){
      if(!candidateHasSurface(c,surface))throw new Error('이 면의 후보가 없습니다.');
      const manifest=plan.manifests.find(m=>m.surface===surface);if(!manifest)throw new PlanStopped('표지 응답을 확인하지 못했어요 · 다시 확인');
      const kind=surface==='front'?'cover':surface;
      if(manifest.kind!==kind||manifest.provider!=='libredmm'||manifest.providerImageId!==`${plan.reviewedCode}:${plan.reviewedJacketSha256}:${c.defaultSplit.x1}:${c.defaultSplit.x2}:${surface}`)throw new PlanStopped('표지 응답을 확인하지 못했어요 · 다시 확인');
      const reused=artworks.find(a=>a.workId===workId&&a.kind===kind&&a.provider==='libredmm'&&a.providerImageId===manifest.providerImageId);
      artworkId=reused?.artworkId??plan.artworkIds[surface];
      if(!reused){const {surface:_,...receipt}=manifest;commands.push({commandType:'addArtwork',workId,artworkId,...receipt});}
    }
    if(artworkId!==expectedArtworkId){commands.push({commandType:'selectArtwork',workId,slot,artworkId,expectedArtworkId});revision++;}
  }
  const changes:AvDetailFields={},expected:AvDetailFields={};
  const fields={...choices.fields};if(!String(base?.details.av?.productCode??'').trim())fields.productCode=detail.inbox.normalizedCode!;
  for(const [key,value] of Object.entries(fields)){
    const k=key as AvDetailKey,old=base?.details.av?.[k]??(k==='genres'?[]:null);
    if(!sameAvValue(value,old)){changes[k]=value;expected[k]=old;}
  }
  validateAvDetails(changes);if(Object.keys(changes).length){commands.push({commandType:'setAvDetails',workId,changes,expected});revision++;}
  const credits:AvCredit[]=(base?.avCredits??[]).map(({personId,role,order,creditName})=>({personId,role,order,creditName:creditName??null})),people:AvNewPerson[]=[];
  for(const p of choices.people){
    if(p.action==='skip')continue;
    const personId=p.action==='link'?p.personId:plan.personIds[p.nameJa];if(!personId)throw new Error('인물을 선택해 주세요.');
    if(credits.some(credit=>credit.role===p.role&&credit.personId===personId))continue;
    const allowed=(p.role==='performer'?c.performers:c.directors).some(person=>person.nameJa===p.nameJa);if(!allowed)throw new Error('인물을 다시 확인해 주세요.');
    if(p.action==='new'&&!people.some(person=>person.personId===personId))people.push({personId,displayName:p.displayName.trim(),nameJa:p.nameJa});
    credits.push({personId,role:p.role,order:credits.filter(v=>v.role===p.role).reduce((max,v)=>Math.max(max,v.order+1),0),creditName:null});
  }
  if(!sameAvValue(credits,base?.avCredits??[])||people.length){validateAvCredits(credits,people,revision);commands.push({commandType:'setAvCredits',workId,credits,people,expectedRevision:revision});}
  return commands.map(command=>({...plan.identity,...command,operationId:crypto.randomUUID()}));
}
function currentPlan(plan:InboxPlan,connection:string){
  const current=readInboxPlans(connection).find(p=>p.id===plan.id);
  return connection===outboxConnection()&&current?.runId===plan.runId&&!!current&&current.state!=='blocked';
}
const passes=new Map<string,Promise<void>>();
export function resumeInboxApplies(identity:AuthorityIdentity):Promise<void>{
  const connection=outboxConnection();if(!connection)return Promise.resolve();
  const existing=passes.get(connection);if(existing)return existing;
  const pass=resume(connection,identity).finally(()=>passes.delete(connection));passes.set(connection,pass);return pass;
}
async function resume(connection:string,identity:AuthorityIdentity){
  for(const snapshot of readInboxPlans(connection)){
    if(connection!==outboxConnection())return;
    let plan=readInboxPlans(connection).find(p=>p.id===snapshot.id);if(!plan)continue;
    if(!sameAuthority(plan.identity,identity)||plan.state==='done'||plan.state==='blocked'||plan.nextAttemptAt>Date.now())continue;
    try {
      if(plan.state==='preparing'){
        const commandDependencies=(plan.dependencies??[]).filter(id=>!id.startsWith('plan:'));
        const dependencies=readCommands(connection).filter(r=>commandDependencies.includes(r.command.operationId));
        if(commandDependencies.some(id=>!dependencies.some(r=>r.command.operationId===id)))throw new PlanStopped('앞선 변경의 확인 응답이 없어졌어요 · 다시 확인');
        const plans=readInboxPlans(connection);
        if((plan.dependencies??[]).some(id=>id.startsWith('plan:')&&plans.some(p=>p.id===id.slice(5)&&p.state==='blocked')))throw new PlanStopped('앞선 품번 적용이 멈췄어요 · 다시 확인');
        if((plan.dependencies??[]).some(id=>id.startsWith('plan:')&&plans.some(p=>p.id===id.slice(5)&&p.state!=='done')))continue;
        if(dependencies.some(r=>r.state==='conflict')) {plan.state='blocked';plan.error='앞선 변경이 다른 기기의 변경과 겹침';save(plan,connection);continue;}
        if(dependencies.some(r=>r.state==='pending'))continue;
        const fresh=await reviewedInboxDetail(plan.id,connection);
        if(!currentPlan(plan,connection))return;
        if(!fresh.candidate){plan.detail=fresh;throw new PlanStopped('후보가 없어졌어요 · 적용 취소해 주세요.');}
        if(normalizeProductCode(fresh.inbox.normalizedCode??fresh.inbox.productCode)!==plan.reviewedCode||fresh.candidate.jacketSha256!==plan.reviewedJacketSha256)
          throw new PlanStopped('후보가 바뀌었어요 · 다시 확인');
        const wanted=SURFACES.filter(s=>plan.choices.surfaces[s]==='candidate'&&!plan.manifests.some(m=>m.surface===s));
        if(wanted.length){
          const split=plan.detail.candidate!.defaultSplit;
          const reply=await api<{items:PreparedArtwork[]}>(`${inboxPath(plan.id)}/artwork`,undefined,{x1:split.x1,x2:split.x2,surfaces:wanted},'POST',false,connection);
          if(!currentPlan(plan,connection))return;
          if(!Array.isArray(reply?.items)||reply.items.length!==wanted.length||wanted.some(s=>reply.items.filter(m=>m.surface===s).length!==1))throw new PlanStopped('표지 응답을 확인하지 못했어요 · 다시 확인');
          plan.manifests.push(...reply.items);save(plan,connection);
        }
        // Fresh baseline confirms state did not change while preparing; it also finds crop reuse.
        const {readInboxAuthority}=await import('./avInboxModel');
        const current=await readInboxAuthority(identity);
        if(!currentPlan(plan,connection))return;
        const work=current.works.find(w=>w.workId===plan.workId);
        if(!plan.isNew&&(!work||!plan.base||!sameCompositionState(work,plan.base)))throw new ApiError('다른 기기에서 컬렉션이 바뀌었습니다.',409,{detail:{code:'revisionConflict'}});
        if(work&&!plan.isNew)plan.base=structuredClone(work);
        if(!plan.commands.length){
          try{plan.commands=composeInboxCommands(plan,current.artworks);}
          catch(error){throw error instanceof PlanStopped?error:new PlanStopped('선택한 내용을 다시 확인해 주세요.');}
        }
        plan.state='sending';plan.attempts=plan.stageAttempts?.sending??0;plan.nextAttemptAt=0;save(plan,connection);
      }
      // A crash after saving the plan but before the queue write replays these exact IDs.
      const predecessors=plan.commands.filter(c=>c.commandType!=='setAvCredits');
      const commands=predecessors.filter(c=>!plan.accepted.includes(c.operationId));
      if(commands.length)enqueueInboxCommands(plan.id,commands,connection);
      const rows=readCommands(connection);
      const accepted=rows.filter(r=>r.inboxId===plan.id&&r.state==='accepted'&&plan.commands.some(c=>c.operationId===r.command.operationId)).map(r=>r.command.operationId);
      plan.accepted=[...new Set([...plan.accepted,...accepted])];
      if(rows.some(r=>r.inboxId===plan.id&&r.state==='conflict')){plan.state='blocked';plan.error='다른 기기의 변경과 겹침';save(plan,connection);continue;}
      const credits=plan.commands.find(c=>c.commandType==='setAvCredits');
      if(credits && !plan.accepted.includes(credits.operationId) && !rows.some(r=>r.command.operationId===credits.operationId)
        && predecessors.every(c=>plan.accepted.includes(c.operationId))) {
        // Only commands never attempted may be finalized. A receipt says whether a CAS
        // became a no-op; artwork admission does not advance the work revision.
        let revision=plan.base?.entityRevision??1;
        for(const command of predecessors) {
          const receipt=rows.find(r=>r.command.operationId===command.operationId)?.receipts?.[0];
          const entity=receipt?.entities?.works?.find(work=>work.workId===plan.workId);
          if(entity && Number.isSafeInteger(entity.entityRevision) && entity.entityRevision>0)revision=entity.entityRevision;
          else if(['selectArtwork','setAvDetails'].includes(command.commandType)) {
            if(typeof receipt?.changed!=='boolean') throw new PlanStopped('변경 확인 응답이 없어요 · 다시 확인');
            if(receipt.changed)revision++;
          }
        }
        if(credits.commandType==='setAvCredits')credits.expectedRevision=revision;
        save(plan,connection);enqueueInboxCommands(plan.id,[credits],connection);
      }
      if(plan.commands.some(c=>!plan.accepted.includes(c.operationId))){save(plan,connection);continue;}
      if(plan.state!=='waiting'){plan.state='waiting';plan.attempts=plan.stageAttempts?.waiting??0;plan.nextAttemptAt=0;}save(plan,connection);
      try {await api(`${inboxPath(plan.id)}/applied`,undefined,{workId:plan.workId},'POST',false,connection);}
      catch(error){const code=error instanceof ApiError?(error.details as {detail?:{code?:string}})?.detail?.code:null;
        if(code!=='avInboxStateConflict'&&code!=='avInboxCandidateUnavailable')throw error;}
      if(!currentPlan(plan,connection))return;
      plan.state='done';plan.doneAt=Date.now();save(plan,connection);releaseInboxCommands(plan.id,connection);
    }catch(error){
      if(!currentPlan(plan,connection))continue;
      const status=error instanceof ApiError?error.status:null;
      const code=error instanceof ApiError?(error.details as {detail?:{code?:string}})?.detail?.code:null;
      if(code==='avInboxWorkMismatch'){plan.state='blocked';plan.error='품번이 다른 컬렉션이에요 · 다시 확인';}
      else if(plan.state!=='waiting'&&['avInboxNotFound','avInboxCandidateUnavailable'].includes(code??'')){plan.state='blocked';plan.detail={...plan.detail,candidate:null};plan.error='후보가 없어졌어요 · 적용 취소해 주세요.';}
      else if(error instanceof PlanStopped){plan.state='blocked';plan.error=error.message;}
      else if(plan.state!=='waiting'&&code!=='baselineChanged'&&status&&status>=400&&status<500&&![401,403,408,429].includes(status)){plan.state='blocked';plan.error='후보를 다시 확인해 주세요.';}
      else {const stage=plan.state as 'preparing'|'sending'|'waiting';plan.stageAttempts??={};plan.attempts=(plan.stageAttempts[stage]??0)+1;plan.stageAttempts[stage]=plan.attempts;plan.nextAttemptAt=Date.now()+Math.min(600_000,15_000*2**Math.min(plan.attempts-1,6));}
      save(plan,connection);
    }
  }
}
