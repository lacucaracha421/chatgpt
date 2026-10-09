import {useCallback, useEffect, useRef, useState} from 'react';
import {InboxArrowDownIcon, ChevronRightIcon, ClockIcon, ExclamationTriangleIcon, CheckIcon, PauseCircleIcon, XMarkIcon} from '@heroicons/react/24/outline';
import {BusyLabel} from '../src/shared/ui/BusyLabel';
import {Button, Badge, Dialog, DialogDescription, Field, TextInput} from './ui';
import {BottomSheet} from './BottomSheet';
import {AvLookupSender} from './AvCollections';
import {AvInboxChooser} from './AvInboxChooser';
import {api, ApiError, errorText} from './transport';
import {normalizeProductCode} from './avLookup';
import {connectionOutbox, outboxConnection, outboxKey} from './outboxConnection';
import {visibleInterval} from './useVisibleInterval';
import {usePrivacyMode} from './privacyMode';
import type {CollectionSummary} from './collectionModel';
import type {useCollectionAuthority} from './useCollectionAuthority';
import {INBOX_APPLY_EVENT, cancelInboxPlan, pauseInboxPlan, retryInboxPlan, readInboxPlans, type InboxPlan} from './avInboxApply';
import {inboxDetail, reviewedInboxDetail, inboxList, inboxPath, readInboxAuthority, type InboxAuthority, type InboxDetail, type InboxItem} from './avInbox';
import {inboxRowThumbnail} from './avInboxThumbnail';
import {StableImage} from '../src/shared/ui/StableImage';
import './avInbox.css';

const LIST_KEY=connectionOutbox('lakomics.av-inbox.last-list.v1');
function hasCachedList(){try{const key=outboxKey(LIST_KEY);return !!key&&localStorage.getItem(key)!==null;}catch{return false;}}
function cachedList():InboxItem[]{try{const value=JSON.parse(localStorage.getItem(outboxKey(LIST_KEY)??'')??'[]');return Array.isArray(value)?value:[];}catch{return [];}}
export function inboxStatus(item:InboxItem,plan?:InboxPlan){
  if(plan?.state==='done')return '적용됨';
  if(plan?.state==='blocked')return '멈춤';
  if(plan?.state==='waiting')return '확인 기다리는 중';
  if(plan)return '보내는 중';
  return item.status==='queued'||item.status==='fetching'?'찾는 중':item.status==='found'?'후보 있음':item.status==='not_found'?'못 찾음':item.status==='error'?'오류':'적용됨';
}
export function InboxEntry({items,plans,onOpen}:{items:InboxItem[];plans:InboxPlan[];onOpen():void}){
  const actionable=items.filter(item=>(plans.some(p=>p.id===item.id&&p.state!=='done')||!['applied','dismissed'].includes(item.status))&&plans.find(p=>p.id===item.id)?.state!=='done');
  if(!actionable.length)return null;
  const counts=new Map<string,number>();for(const item of actionable){const status=inboxStatus(item,plans.find(p=>p.id===item.id));counts.set(status,(counts.get(status)??0)+1);}
  return <button className="av-inbox-entry" onClick={onOpen} aria-label={`받은 품번 ${actionable.length}`}><InboxArrowDownIcon aria-hidden="true"/><span><b>받은 품번 <Badge>{actionable.length}</Badge></b><small>{['후보 있음','찾는 중','보내는 중','확인 기다리는 중','멈춤','못 찾음','오류'].filter(s=>counts.has(s)).map((s,i)=><span key={s} className={s==='멈춤'?'av-inbox-danger':undefined}>{i>0?' · ':''}{s} {counts.get(s)}</span>)}</small></span><ChevronRightIcon aria-hidden="true"/></button>;
}
function RowThumbnail({detail,privateMode}:{detail:InboxDetail;privateMode:boolean}){
  const [url,setUrl]=useState<string|null>(null);
  useEffect(()=>{if(privateMode)return;const abort=new AbortController();void inboxRowThumbnail(detail,abort.signal).then(value=>{if(!abort.signal.aborted)setUrl(value);}).catch(()=>{});return()=>abort.abort();},[detail,privateMode]);
  return !privateMode&&url?<span className="av-inbox-thumb"><StableImage src={url} alt="앞표지 후보"/></span>:<span className="av-inbox-thumb">—</span>;
}
type Authority=ReturnType<typeof useCollectionAuthority>;
export function AvInbox({active,authority,items,open,onClose,onOpen}:{active:boolean;authority:Authority;items:CollectionSummary[];open:boolean;onClose():void;onOpen():void}){
  const connection=outboxConnection();const [rows,setRows]=useState(cachedList),[plans,setPlans]=useState(readInboxPlans),[offline,setOffline]=useState(false),[busy,setBusy]=useState(false),[error,setError]=useState('');
  const [listReady,setListReady]=useState(hasCachedList);
  const [details,setDetails]=useState<Record<string,InboxDetail>>({});
  const knownDetails=useRef(details);knownDetails.current=details;
  const [chooser,setChooser]=useState<{detail:InboxDetail;authority:InboxAuthority}|null>(null);
  const [confirm,setConfirm]=useState<InboxItem|null>(null),[editing,setEditing]=useState<InboxItem|null>(null),[code,setCode]=useState('');
  const [privacy]=usePrivacyMode();const walking=useRef<string[]|null>(null),loading=useRef(false),mounted=useRef(true),openRef=useRef(open);openRef.current=open;
  const controllers=useRef(new Set<AbortController>());
  const choiceRead=useRef(0);
  useEffect(()=>{mounted.current=true;return()=>{mounted.current=false;for(const c of controllers.current)c.abort();};},[]);
  useEffect(()=>{setRows(cachedList());setListReady(hasCachedList());setPlans(readInboxPlans());setDetails({});setChooser(null);setOffline(false);},[connection]);
  const refresh=useCallback(async()=>{
    if(loading.current||!active)return;loading.current=true;
    const controller=new AbortController();controllers.current.add(controller);
    try{const next=await inboxList(controller.signal);if(!mounted.current||controller.signal.aborted||connection!==outboxConnection())return;
      setRows(next);setListReady(true);
      for(const plan of readInboxPlans().filter(p=>p.state==='blocked'))if(!next.some(item=>item.id===plan.id&&item.status==='found'))pauseInboxPlan(plan.id);
      setOffline(false);const key=outboxKey(LIST_KEY,connection);if(key){try{localStorage.setItem(key,JSON.stringify(next));}catch{/* Optional last-list cache; apply storage failures remain visible. */}}
      if(openRef.current){
        const found=next.filter(item=>item.status==='found');
        for(const item of found){const cached=knownDetails.current[item.id];if(cached?.candidate&&cached.inbox.normalizedCode===item.normalizedCode&&cached.inbox.fetchedAt===item.fetchedAt)continue;const detail=await inboxDetail(item.id,controller.signal);if(controller.signal.aborted||!mounted.current||!openRef.current)return;setDetails(current=>({...current,[item.id]:detail}));if(!detail.candidate)pauseInboxPlan(item.id,detail);}
      }
    }catch(reason){if(mounted.current&&!controller.signal.aborted&&connection===outboxConnection()){setOffline(true);setError(errorText(reason));}}
    finally{controllers.current.delete(controller);loading.current=false;}
  },[active,connection]);
  useEffect(()=>{if(!active)return;void refresh();const stop=visibleInterval(()=>void refresh(),open?rows.some(item=>['queued','fetching'].includes(item.status))?5000:15000:60000);return stop;},[active,open,refresh,rows.some(item=>['queued','fetching'].includes(item.status))]);
  useEffect(()=>{const read=()=>{setPlans(readInboxPlans());setNow(Date.now());};window.addEventListener(INBOX_APPLY_EVENT,read);return()=>window.removeEventListener(INBOX_APPLY_EVENT,read);},[connection]);
  const [now,setNow]=useState(Date.now());
  useEffect(()=>{const currentTime=Date.now();const due=plans.filter(p=>p.state==='done'&&p.doneAt&&p.doneAt+1200>currentTime);if(!due.length)return;const timer=setTimeout(()=>setNow(Date.now()),Math.min(...due.map(p=>p.doneAt!+1200-currentTime)));return()=>clearTimeout(timer);},[plans,now]);
  // A missing server row does not erase a durable send or a pending 404 acknowledgement.
  const mergedRows=[...rows,...plans.filter(plan=>!rows.some(item=>item.id===plan.id)&&(plan.state!=='done'||(plan.doneAt??0)+1200>now)).map(plan=>plan.detail.inbox)].sort((a,b)=>b.sequence-a.sequence);
  const visible=mergedRows.filter(item=>(plans.some(p=>p.id===item.id&&p.state!=='done')||!['applied','dismissed'].includes(item.status))&&!plans.some(p=>p.id===item.id&&p.state==='done'&&(p.doneAt??0)+1200<=now));
  const found=visible.filter(item=>item.status==='found'&&!plans.some(p=>p.id===item.id&&(p.state!=='blocked'||!p.detail.candidate)));
  const showCandidate=async(id:string)=>{
    if(offline||busy||!authority.identity)return;const read=++choiceRead.current;setBusy(true);setError('');const abort=new AbortController();controllers.current.add(abort);
    try{const detail=await reviewedInboxDetail(id,connection,abort.signal);if(!detail.candidate){pauseInboxPlan(id,detail);setDetails(current=>({...current,[id]:detail}));return;}const state=await readInboxAuthority(authority.identity,abort.signal);
      if(read===choiceRead.current&&mounted.current&&openRef.current&&!abort.signal.aborted&&connection===outboxConnection()){setChooser({detail,authority:state});setDetails(current=>({...current,[id]:detail}));}}
    catch(reason){if(!abort.signal.aborted){if(reason instanceof ApiError&&reason.status===404)pauseInboxPlan(id);else setError(errorText(reason));}}finally{controllers.current.delete(abort);setBusy(false);}
  };
  const advance=()=>{const next=walking.current?.shift();if(next)void showCandidate(next);else {walking.current=null;setChooser(null);}};
  const action=async(item:InboxItem,name:'retry'|'fix-code'|'dismiss',body:unknown={})=>{
    if(offline||busy||readInboxPlans().some(p=>p.id===item.id&&p.state!=='done'))return;setBusy(true);setError('');
    try{await api(`${inboxPath(item.id)}/${name}`,undefined,body,'POST',false,connection??undefined);setConfirm(null);setEditing(null);setDetails(current=>{const copy={...current};delete copy[item.id];return copy;});if(name==='dismiss'&&chooser?.detail.inbox.id===item.id){setChooser(null);walking.current=null;}await refresh();}
    catch(reason){setError(errorText(reason));}finally{setBusy(false);}
  };
  const discard=(item:InboxItem)=>{if(item.status==='found')setConfirm(item);else void action(item,'dismiss');};
  return <><InboxEntry items={mergedRows} plans={plans} onOpen={onOpen}/>{open&&<BottomSheet tall headerActions={<Button variant="ghost" disabled={offline||busy||!found.length||!authority.identity} onClick={()=>{walking.current=found.slice(1).map(item=>item.id);void showCandidate(found[0]!.id);}}>후보 차례로 보기 {found.length}</Button>} title={`받은 품번 ${visible.length}`} onClose={()=>{choiceRead.current++;walking.current=null;setChooser(null);onClose();}}><div className="av-inbox-list">
    <AvLookupSender disabled={offline} onSent={()=>void refresh()}/>
    <BusyLabel busy={busy}>확인하는 중</BusyLabel>
    {offline&&<div className="av-inbox-offline"><span>서버에 연결되지 않음 · 마지막으로 받은 목록</span><Button disabled={busy} onClick={()=>void refresh()}>다시 시도</Button></div>}
    {!offline&&error&&<p role="alert">{error}</p>}
    {visible.map(item=>{const plan=plans.find(p=>p.id===item.id),status=inboxStatus(item,plan),sending=plan&&!['blocked','done'].includes(plan.state),detail=plan?.state==='blocked'&&!plan.detail.candidate?plan.detail:details[item.id]??plan?.detail;const Icon=status==='적용됨'?CheckIcon:status==='멈춤'?PauseCircleIcon:status==='못 찾음'||status==='오류'?ExclamationTriangleIcon:ClockIcon;
      return <div className={`av-inbox-row${status==='적용됨'?' is-done':''}`} key={item.id}>
        {editing?.id===item.id?<form className="av-inbox-edit" onSubmit={event=>{event.preventDefault();const normalized=normalizeProductCode(code);if(normalized)void action(item,'fix-code',{productCode:normalized});}}><Field label={`품번 고치기 · 받은 값 ${item.productCode}`}><TextInput value={code} autoFocus onChange={e=>setCode(e.target.value)}/></Field><small>정규화: {normalizeProductCode(code)??'—'} · 저장하면 다시 찾아요</small><Button type="submit" variant="primary" disabled={offline||busy||!normalizeProductCode(code)}>저장</Button><Button onClick={()=>setEditing(null)}>취소</Button></form>:<>
        <span className="av-inbox-row-image">{detail?.candidate&&status!=='적용됨'?<RowThumbnail detail={detail} privateMode={privacy}/>:<Icon aria-hidden="true"/>}</span><div className="av-inbox-row-text"><div><b>{item.normalizedCode??item.productCode}</b><Badge variant={status==='멈춤'||status==='오류'?'danger':'plain'}>{status}{status==='보내는 중'&&plan&&plan.commands.length>0?` ${plan.accepted.length}/${plan.commands.length}`:''}</Badge></div><small>{plan?.state==='blocked'?`${plan.error??'적용이 멈췄어요'} · ${plan.accepted.length}개 적용됨`:plan?.state==='waiting'?'서버 확인 기다리는 중':detail?.candidate?`${detail.matches.length===1?'기존 컬렉션에 후보 추가':detail.matches.length>1?`같은 품번 컬렉션 ${detail.matches.length}개 · 넣을 곳 고르기`:'새 AV 컬렉션'} · ${item.titleJa??''}`:item.status==='not_found'?'LibreDMM에 없는 품번':item.status==='error'?'가져오지 못함':`${item.receivedAt.slice(0,10)} 받음 · LibreDMM`}</small></div>
        <div className="av-inbox-row-actions">{item.status==='found'&&!plan&&<Button disabled={offline||busy||!authority.identity} onClick={()=>{walking.current=null;void showCandidate(item.id);}}>후보 보기</Button>}{plan?.state==='blocked'&&detail?.candidate&&item.status==='found'&&<Button disabled={offline||busy||!authority.identity} onClick={()=>{walking.current=null;void showCandidate(item.id);}}>다시 확인</Button>}{plan?.state==='blocked'&&<Button disabled={busy} onClick={()=>{try{cancelInboxPlan(item.id);setChooser(null);walking.current=null;if(item.status!=='found'||!detail?.candidate)setRows(current=>current.filter(row=>row.id!==item.id));void authority.flush();}catch(reason){setError(errorText(reason));}}}>적용 취소</Button>}{plan?.state==='waiting'&&<Button disabled={offline||busy} onClick={()=>{retryInboxPlan(item.id);void authority.flush();}}>다시 시도</Button>}{['not_found','error'].includes(item.status)&&!plan&&<><Button disabled={offline||busy} onClick={()=>void action(item,'retry')}>다시 시도</Button><Button disabled={offline||busy} onClick={()=>{setEditing(item);setCode(item.normalizedCode??item.productCode);}}>품번 고치기</Button></>}</div>{!sending&&status!=='적용됨'&&<Button variant="ghost" aria-label={`${item.normalizedCode??item.productCode} 버리기`} disabled={offline||busy||!!plan} onClick={()=>discard(item)}><XMarkIcon aria-hidden="true"/></Button>}</>}
      </div>;})}
    {!listReady&&!offline&&<BusyLabel busy>불러오는 중</BusyLabel>}{listReady&&!visible.length&&<p className="muted">받은 품번 없음</p>}
  </div></BottomSheet>}
  {open&&chooser&&<AvInboxChooser key={chooser.detail.inbox.id} detail={chooser.detail} authority={chooser.authority} items={items} disabled={offline||busy} onClose={()=>{choiceRead.current++;walking.current=null;setChooser(null);}} onLater={advance} onApplied={()=>{void authority.flush();advance();}} onReject={()=>setConfirm(chooser.detail.inbox)}/>}
  {confirm&&<Dialog open title={`${confirm.normalizedCode??confirm.productCode} 후보를 버릴까요?`} onClose={()=>setConfirm(null)}><DialogDescription>가져온 후보만 지워져요. 같은 품번을 다시 보내면 다시 찾아요.</DialogDescription><div className="ui-dialog__actions"><Button onClick={()=>setConfirm(null)}>취소</Button><Button variant="danger" disabled={offline||busy} onClick={()=>void action(confirm,'dismiss')}>버리기</Button></div></Dialog>}
  </>;
}
