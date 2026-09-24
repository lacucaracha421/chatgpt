import {useVisibleInterval} from './useVisibleInterval';
import {useEffect, useRef, useState} from 'react';
import {ArrowPathIcon, CloudArrowDownIcon} from '@heroicons/react/24/outline';
import {IconButton} from './ui';
import {BottomSheet} from './BottomSheet';
import {api, errorText} from './transport';

type Language = 'korean' | 'japanese';
export type RefreshJob = {id:string; language:Language; state:'queued'|'running'|'completed'|'failed'; pages:number; added:number; hasMore:boolean; error:string|null; publicationRevision:string|null};
type Pending = {operationId:string; language:Language};
type Options = {supported?:boolean;active:boolean; language:Language|'all'; publication:string|null; endpoint:string; onPublished():void};

/** Server-side catalog refresh: capability, job polling and one durable request at a time. */
export function useCatalogRefresh({supported=false, active, language, publication, endpoint, onPublished}:Options) {
  const [job,setJob]=useState<RefreshJob|null>(null);
  const [sending,setSending]=useState(false),[error,setError]=useState('');
  const owner=useRef<AbortController|null>(null),onPublishedRef=useRef(onPublished);
  const notified=useRef<string|null>(null);
  onPublishedRef.current=onPublished;
  const storageKey=`lakomics.catalog.refresh.${endpoint}`;
  const running=job?.state==='queued'||job?.state==='running';
  useEffect(()=>()=>owner.current?.abort(),[]);
  const polling=useRef<AbortController|null>(null);
  const accept=(next:RefreshJob|null)=>{
    setJob(next);setError('');
    try{if(next?.state==='queued'||next?.state==='running')localStorage.setItem(`${storageKey}.job`,JSON.stringify(next));else localStorage.removeItem(`${storageKey}.job`);}catch{/* Optional recovery hint. */}
    if(next?.state==='completed'&&next.publicationRevision&&notified.current!==next.id){
      notified.current=next.id;if(next.publicationRevision!==publication)onPublishedRef.current();
    }
  };
  useEffect(()=>{
    setJob(null);notified.current=null;
    try{const saved=JSON.parse(localStorage.getItem(`${storageKey}.job`)??'null') as RefreshJob|null;
      if(saved&&typeof saved.id==='string'&&(saved.state==='queued'||saved.state==='running'))setJob(saved);
    }catch{/* Ignore malformed optional state. */}
  },[storageKey]);
  useEffect(()=>{
    const hide=()=>{if(document.visibilityState==='hidden'){polling.current?.abort();polling.current=null;}};
    document.addEventListener('visibilitychange',hide);
    return()=>{hide();polling.current?.abort();polling.current=null;document.removeEventListener('visibilitychange',hide);};
  },[active,storageKey]);
  useVisibleInterval(()=>{
    if(polling.current)return;
    const controller=polling.current=new AbortController();
    void api<{job:RefreshJob|null}>('/v1/mobile-catalog/refresh',controller.signal).then(result=>{
      if(!controller.signal.aborted)accept(result.job);
    }).catch(reason=>{if(!controller.signal.aborted)setError(errorText(reason));})
      .finally(()=>{if(polling.current===controller)polling.current=null;});
  },active&&supported&&running?2000:null,true);

  async function request(target:Language){
    if(owner.current||running||!active||!supported||document.visibilityState==='hidden')return;
    const controller=new AbortController();owner.current=controller;setSending(true);setError('');
    try{
      let pending:Pending|null=null;
      try{const saved=JSON.parse(localStorage.getItem(storageKey)||'null') as Pending|null;
        if(saved&&typeof saved.operationId==='string'&&/^[a-f0-9-]{36}$/.test(saved.operationId)&&(saved.language==='korean'||saved.language==='japanese'))pending=saved;
      }catch{/* Storage may be unavailable. The server also deduplicates active work. */}
      pending??={operationId:crypto.randomUUID(),language:target};
      try{localStorage.setItem(storageKey,JSON.stringify(pending));}catch{/* Keep this request usable in memory. */}
      const result=await api<{job:RefreshJob}>('/v1/mobile-catalog/refresh',controller.signal,pending);
      if(controller.signal.aborted)return;
      try{localStorage.removeItem(storageKey);}catch{/* No credentials are stored here. */}
      accept(result.job);
    }catch(reason){if(!controller.signal.aborted)setError(errorText(reason));}
    finally{if(owner.current===controller){owner.current=null;if(!controller.signal.aborted)setSending(false);}}
  }
  const failure=error||(job?.state==='failed'?job.error||'갱신하지 못했습니다. 다시 시도해 주세요.':'');
  return {supported, job, sending, running, failure, request, language};
}
export type CatalogRefreshState = ReturnType<typeof useCatalogRefresh>;

/** Elapsed time since the catalog was last published, for the title bar. */
export function syncedLabel(publishedAt:string|null|undefined, now:number) {
  const at=publishedAt?Date.parse(publishedAt):Number.NaN;
  if(!Number.isFinite(at))return '';
  const minutes=Math.max(0,Math.floor((now-at)/60_000));
  if(minutes<1)return '방금 갱신';
  if(minutes<60)return `${minutes}분 전 갱신`;
  if(minutes<1440)return `${Math.floor(minutes/60)}시간 전 갱신`;
  return `${Math.floor(minutes/1440)}일 전 갱신`;
}
export function useNow(active:boolean, interval=30_000) {
  const [now,setNow]=useState(()=>Date.now());
  useVisibleInterval(()=>setNow(Date.now()),active?interval:null,true);
  return now;
}

/** Title-bar status text and the "fetch new works" action. */
export function CatalogRefreshControl({state, publishedAt, now, onReload, reloadBusy}:{state:CatalogRefreshState; publishedAt?:string|null; now:number; onReload?():void; reloadBusy?:boolean}) {
  const [choose,setChoose]=useState(false);
  const status=state.sending?'요청 중':state.running?'갱신 중':syncedLabel(publishedAt,now);
  return <>
    {status&&<span className="catalog-synced" role="status">{status}</span>}
    {state.supported
      ?<IconButton label="새 작품 가져오기" icon={CloudArrowDownIcon} disabled={state.sending||state.running} onClick={()=>{if(state.language==='all')setChoose(true);else void state.request(state.language);}}/>
      :onReload&&<IconButton label="카탈로그 새로고침" icon={ArrowPathIcon} disabled={reloadBusy} onClick={onReload}/>}
    {choose&&<BottomSheet title="가져올 언어" onClose={()=>setChoose(false)}>
      <div role="radiogroup" aria-label="가져올 언어">{(['korean','japanese'] as const).map(value=><button key={value} className="sheet-option" role="radio" aria-checked={false} onClick={()=>{setChoose(false);void state.request(value);}}>{value==='korean'?'한국어':'일본어'}<span className="radio-dot"/></button>)}</div>
    </BottomSheet>}
  </>;
}

/** Progress or failure of a running refresh, shown above the list. */
export function CatalogRefreshBanner({state}:{state:CatalogRefreshState}) {
  if(state.failure)return <p className="catalog-banner is-error" role="alert">{state.failure}</p>;
  if(!state.running)return null;
  const job=state.job!;
  return <p className="catalog-banner"><ArrowPathIcon aria-hidden="true"/><span><strong>새 작품 가져오는 중</strong>{job.pages>0?` · ${job.pages}페이지 확인`:''}{job.added>0?` · ${job.added}개 추가`:''}</span></p>;
}

export function CatalogRefresh(props:Options) {
  const state=useCatalogRefresh(props),now=useNow(props.active);
  if(!state.supported)return null;
  return <div className="catalog-refresh"><CatalogRefreshControl state={state} now={now}/><CatalogRefreshBanner state={state}/></div>;
}
