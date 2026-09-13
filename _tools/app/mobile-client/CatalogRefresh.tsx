import {useEffect, useRef, useState} from 'react';
import {ArrowPathIcon} from '@heroicons/react/24/outline';
import {Button} from './ui';
import {api, errorText} from './transport';

type Language = 'korean' | 'japanese';
export type RefreshJob = {id:string; language:Language; state:'queued'|'running'|'completed'|'failed'; pages:number; added:number; hasMore:boolean; error:string|null; publicationRevision:string|null};
type Pending = {operationId:string; language:Language};

export function CatalogRefresh({active, language, publication, endpoint, onPublished}:{active:boolean; language:Language|'all'; publication:string|null; endpoint:string; onPublished():void}) {
  const [supported,setSupported]=useState(false),[job,setJob]=useState<RefreshJob|null>(null);
  const [sending,setSending]=useState(false),[error,setError]=useState(''),[check,setCheck]=useState(0);
  const [allLanguage,setAllLanguage]=useState<Language>('korean');
  const owner=useRef<AbortController|null>(null),onPublishedRef=useRef(onPublished);
  const notified=useRef<string|null>(null);
  onPublishedRef.current=onPublished;
  const storageKey=`lakomics.catalog.refresh.${endpoint}`;
  const target=language==='all'?allLanguage:language;
  const running=job?.state==='queued'||job?.state==='running';
  useEffect(()=>()=>owner.current?.abort(),[]);
  useEffect(()=>{
    if(!active)return;
    const controller=new AbortController();let timer:ReturnType<typeof setTimeout>|undefined;
    async function poll(){
      try{
        const status=await api<{capabilities?:{refreshRequest?:boolean}}>('/v1/mobile-catalog/status',controller.signal);
        if(controller.signal.aborted)return;
        const enabled=status.capabilities?.refreshRequest===true;setSupported(enabled);
        if(!enabled)return;
        const result=await api<{job:RefreshJob|null}>('/v1/mobile-catalog/refresh',controller.signal);
        if(controller.signal.aborted)return;
        setJob(result.job);setError('');
        if(result.job?.state==='completed'&&result.job.publicationRevision&&notified.current!==result.job.id){
          notified.current=result.job.id;
          if(result.job.publicationRevision!==publication)onPublishedRef.current();
        }
        timer=setTimeout(()=>void poll(),result.job?.state==='queued'||result.job?.state==='running'?2000:30000);
      }catch(reason){if(!controller.signal.aborted){setError(errorText(reason));timer=setTimeout(()=>void poll(),10000);}}
    }
    void poll();return()=>{controller.abort();clearTimeout(timer);};
  },[active,check,publication]);

  async function request(){
    if(owner.current||running)return;
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
      setJob(result.job);setCheck(value=>value+1);
    }catch(reason){if(!controller.signal.aborted)setError(errorText(reason));}
    finally{if(owner.current===controller){owner.current=null;if(!controller.signal.aborted)setSending(false);}}
  }

  if(!supported)return null;

  return <div className="catalog-refresh">
    <div className="catalog-refresh-actions">
      {language==='all'&&<select aria-label="갱신할 카탈로그 언어" value={allLanguage} disabled={sending||running} onChange={event=>setAllLanguage(event.target.value as Language)}><option value="korean">한국어</option><option value="japanese">일본어</option></select>}
      <Button aria-label="카탈로그 갱신" size="sm" variant="ghost" disabled={sending||running} onClick={()=>void request()}><ArrowPathIcon/>{sending?'요청 중':running?'갱신 중':job?.hasMore&&job.language===target?'계속 갱신':'갱신'}</Button>

    </div>
    {(error||job?.state==='failed')&&<p role="alert">{error||job?.error||'갱신하지 못했습니다. 다시 시도해 주세요.'}</p>}
  </div>;
}
