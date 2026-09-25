import {useCallback,useEffect,useRef,useState} from 'react';
import {ArrowLeftIcon,ArrowUturnLeftIcon,BookOpenIcon,ChevronRightIcon,Square2StackIcon} from '@heroicons/react/24/outline';
import {Button,IconButton} from './ui';
import {ApiError,api,errorText} from './transport';
import {CatalogCover} from './CatalogCover';
import {catalogDetailPath,type CatalogDetail} from './catalogModel';
import {catalogDisplayTitle} from '../src/manga/catalogDisplayTitle';
import {useDueFlush} from './useSimilarityReview';
import {DUPLICATE_REVIEW_EVENT,DUPLICATE_SETTLED_EVENT,commitDuplicateDecision,duplicatesPath,flushDuplicateDecisions,nextDuplicateDue,readDuplicateIntents,undoDuplicateDecision,
  type DuplicateCandidate,type DuplicateChoice,type DuplicateFeed,type DuplicateIntent,type DuplicateOutcome,type DuplicateState,type DuplicateWork} from './catalogDuplicates';
import './characterReview.css';
import './catalogDuplicates.css';

const LABEL:Record<DuplicateChoice,string>={keepBoth:'같은 작품으로 묶기',notDuplicate:'다른 작품'};
const SAVED:Record<DuplicateChoice,string>={keepBoth:'같은 작품으로 묶었어요',notDuplicate:'다른 작품으로 표시했어요'};
const STATUS:Record<string,string>={keepBoth:'같은 작품으로 묶음',notDuplicate:'다른 작품',hideEdition:'판본 숨김'};
const PC_NOTE='PC가 켜지면 카탈로그에 반영돼요.';

/** Sends queued duplicate decisions in the background (mounted once by the app). */
export function useDuplicateDecisionFlush(enabled:boolean){
  useDueFlush(enabled,nextDuplicateDue,flushDuplicateDecisions,DUPLICATE_REVIEW_EVENT);
}

/** Pairs that need a look (undecided on the server, minus this device's queued decisions); null while unknown. */
export function useDuplicateCount(enabled:boolean):number|null{
  const [count,setCount]=useState<number|null>(null);
  useEffect(()=>{
    if(!enabled)return;
    const controller=new AbortController();
    void api<DuplicateFeed>(duplicatesPath('undecided',null,1),controller.signal).then(feed=>{
      if(controller.signal.aborted)return;
      const queued=Object.values(readDuplicateIntents()).filter(intent=>intent.base===null).length;
      setCount(Number.isSafeInteger(feed?.counts?.undecided)?Math.max(0,feed.counts.undecided-queued):null);
    },()=>{if(!controller.signal.aborted)setCount(null);});
    return()=>controller.abort();
  },[enabled]);
  return enabled?count:null;
}

/** A quiet row for the catalog filter sheet: "중복 판본 검토", with a count only when some need a look. */
export function DuplicateReviewEntry({count,onOpen}:{count:number|null;onOpen():void}){
  return <button type="button" className="review-entry duplicate-entry" onClick={onOpen} aria-label={count?`중복 판본 검토, 확인 필요 ${count}개`:'중복 판본 검토'}>
    <Square2StackIcon aria-hidden="true"/><strong>중복 판본 검토</strong>{!!count&&<span className="numeric muted">{count}</span>}<ChevronRightIcon aria-hidden="true"/>
  </button>;
}

/** One side's cover. The candidate carries no cover URL, so it is read from the work's catalog detail. */
function DuplicateCover({provider,work,context,active}:{provider:string;work:DuplicateWork;context:string|null;active:boolean}){
  const [cover,setCover]=useState<{url:string;revision:string}|null>(null);
  useEffect(()=>{
    if(!context||!active||provider!=='kHentai')return;
    const controller=new AbortController();
    void api<{publicationRevision:string;item:CatalogDetail}>(catalogDetailPath({provider,providerWorkId:work.workId},context),controller.signal).then(result=>{
      if(!controller.signal.aborted&&result?.item?.thumbnailUrl)setCover({url:result.item.thumbnailUrl,revision:result.publicationRevision});
    },()=>{});
    return()=>controller.abort();
  },[provider,work.workId,context,active]);
  return <div className="catalog-cover duplicate-cover">
    {cover?<CatalogCover item={{provider:'kHentai',providerWorkId:work.workId,thumbnailUrl:cover.url}} revision={cover.revision} active={active}/>
      :<span className="duplicate-cover-missing" aria-hidden="true"><BookOpenIcon/></span>}
    <span className="catalog-cover-pages numeric">{work.pages}p</span>
  </div>;
}

const creatorText=(work:DuplicateWork)=>work.creators.map(value=>value.replace(/^(artist|group):/,'')).join(' · ')||'작가 미상';

function Side({provider,work,context,active}:{provider:string;work:DuplicateWork;context:string|null;active:boolean}){
  const title=catalogDisplayTitle(work.title);
  return <div className="duplicate-side">
    <DuplicateCover provider={provider} work={work} context={context} active={active}/>
    <strong title={title!==work.title?work.title:undefined}>{title||work.titleJpn||work.workId}</strong>
    <span>{creatorText(work)}</span>
    <span className="numeric">{work.pages}p{work.languages.length?` · ${work.languages.join(', ')}`:''}</span>
  </div>;
}

type State={phase:'loading'}|{phase:'error';message:string;offline:boolean}|{phase:'ready'};

/**
 * Full-screen duplicate-edition review over the catalog. "확인 필요" lists the pairs the PC
 * was not sure about; "처리됨" lists decided pairs (including the ones the PC merged on its
 * own), each of which can be changed. The PC applies every decision when it republishes.
 */
export function CatalogDuplicates({context,active=true,onClose}:{context:string|null;active?:boolean;onClose():void}){
  const [tab,setTab]=useState<DuplicateState>('undecided');
  const [state,setState]=useState<State>({phase:'loading'});
  const [items,setItems]=useState<DuplicateCandidate[]>([]);
  const [counts,setCounts]=useState<DuplicateFeed['counts']|null>(null);
  const [cursor,setCursor]=useState<string|null>(null);
  const [queued,setQueued]=useState(readDuplicateIntents);
  const [undo,setUndo]=useState<DuplicateIntent|null>(null);
  const [notice,setNotice]=useState('');
  const [reload,setReload]=useState(0);
  const loading=useRef<AbortController|null>(null);

  const load=useCallback(async(from:string|null)=>{
    loading.current?.abort();
    const controller=new AbortController();loading.current=controller;
    try{
      const feed=await api<DuplicateFeed>(duplicatesPath(tab,from),controller.signal);
      if(controller.signal.aborted)return;
      if(feed?.version!==1||!Array.isArray(feed.items))throw new Error('중복 판본 목록을 확인할 수 없어요.');
      setCounts(feed.counts);
      setCursor(feed.hasMore?feed.nextCursor:null);
      setItems(current=>{
        if(!from)return feed.items;
        const seen=new Set(current.map(item=>item.candidateId));
        return [...current,...feed.items.filter(item=>!seen.has(item.candidateId))];
      });
      setState({phase:'ready'});
    }catch(reason){
      if(controller.signal.aborted)return;
      if(from){setNotice(errorText(reason));return;}
      const missing=reason instanceof ApiError&&reason.status===404;
      setState({phase:'error',offline:reason instanceof ApiError&&reason.status===null,message:missing?'서버 업데이트가 필요해요.':errorText(reason)});
    }
  },[tab]);

  useEffect(()=>{void load(null);return()=>loading.current?.abort();},[load,reload]);
  useEffect(()=>{
    const read=()=>setQueued(readDuplicateIntents());
    let timer=0;
    const settled=(event:Event)=>{
      const outcome=(event as CustomEvent<DuplicateOutcome>).detail;
      if(outcome?.outcome==='rejected'&&outcome.message)setNotice(outcome.message);
      clearTimeout(timer);timer=window.setTimeout(()=>setReload(n=>n+1),300);
    };
    window.addEventListener(DUPLICATE_REVIEW_EVENT,read);
    window.addEventListener(DUPLICATE_SETTLED_EVENT,settled);
    return()=>{clearTimeout(timer);window.removeEventListener(DUPLICATE_REVIEW_EVENT,read);window.removeEventListener(DUPLICATE_SETTLED_EVENT,settled);};
  },[]);
  // The snackbar lasts while its decision can still be taken back on this device.
  useEffect(()=>{if(undo&&queued[undo.candidateId]?.operationId!==undo.operationId)setUndo(null);},[queued,undo]);

  function act(item:DuplicateCandidate,decision:DuplicateChoice){
    try{
      const intent=commitDuplicateDecision(item,decision);
      setNotice('');setUndo(intent);
    }catch(reason){setNotice(errorText(reason));}
  }
  function revert(){
    if(!undo)return;
    if(!undoDuplicateDecision(undo))setNotice('이미 보냈어요. ‘처리됨’에서 바꿀 수 있어요.');
    setUndo(null);
  }
  function switchTab(next:DuplicateState){
    if(next===tab)return;
    setTab(next);setItems([]);setCursor(null);setState({phase:'loading'});setNotice('');
  }

  const pending=Object.keys(queued).length;
  const shown=tab==='undecided'?items.filter(item=>!queued[item.candidateId]):items;
  const need=counts?Math.max(0,counts.undecided-Object.values(queued).filter(intent=>intent.base===null).length):null;
  return <div className="duplicates-overlay" role="dialog" aria-modal="true" aria-label="중복 판본 검토">
    <header className="review-bar">
      <IconButton label="검토 닫기" icon={ArrowLeftIcon} onClick={onClose}/>
      <div className="review-title"><h1>중복 판본 검토</h1><p>{pending?`전송 대기 ${pending} · `:''}{PC_NOTE}</p></div>
    </header>
    <div className="library-segments duplicates-tabs" role="tablist" aria-label="검토 목록">
      <button role="tab" aria-selected={tab==='undecided'} onClick={()=>switchTab('undecided')}>확인 필요{need?<span className="numeric"> {need}</span>:''}</button>
      <button role="tab" aria-selected={tab==='decided'} onClick={()=>switchTab('decided')}>처리됨{counts?.decided?<span className="numeric"> {counts.decided}</span>:''}</button>
    </div>
    {notice&&<p className="error-message review-notice" role="alert">{notice}</p>}
    {state.phase==='loading'&&<div className="loading-line" role="status" aria-label="검토 목록 불러오는 중"/>}
    {state.phase==='error'&&<div className="empty-state review-empty">
      <h2>{state.offline?'오프라인이에요':'목록을 불러오지 못했어요'}</h2>
      <p>{state.offline?(pending?`저장된 결정 ${pending}개는 연결되면 전송돼요.`:'연결을 확인한 뒤 다시 시도해 주세요.'):state.message}</p>
      <Button onClick={()=>{setState({phase:'loading'});setReload(n=>n+1);}}>다시 시도</Button>
    </div>}
    {state.phase==='ready'&&!shown.length&&<div className="empty-state review-empty">
      <Square2StackIcon aria-hidden="true"/>
      {tab==='undecided'?<><h2>검토할 중복 판본이 없어요</h2><p>확실한 판본은 PC가 자동으로 묶어요. 헷갈리는 것만 여기에 모여요.</p></>
        :<><h2>처리한 판본이 없어요</h2><p>묶거나 다른 작품으로 표시한 판본이 여기에 보여요.</p></>}
    </div>}
    {state.phase==='ready'&&!!shown.length&&<div className="duplicates-list">
      {shown.map(item=>{
        const local=queued[item.candidateId];
        const current=local?.decision??item.decision?.decision??null;
        return <article key={item.candidateId} className="duplicate-card" aria-label={catalogDisplayTitle(item.left.title)||item.left.workId}>
          <div className="duplicate-pair">
            <Side provider={item.provider} work={item.left} context={context} active={active}/>
            <Side provider={item.provider} work={item.right} context={context} active={active}/>
          </div>
          <p className="duplicate-reason">{item.reasonText}</p>
          {tab==='undecided'
            ?<div className="duplicate-actions">
              <Button variant="primary" onClick={()=>act(item,'keepBoth')}>{LABEL.keepBoth}</Button>
              <Button variant="secondary" onClick={()=>act(item,'notDuplicate')}>{LABEL.notDuplicate}</Button>
            </div>
            :<div className="duplicate-actions is-decided">
              <span className="duplicate-status">{current?STATUS[current]??current:'확인 필요'}{local&&<small> · 전송 대기</small>}</span>
              {current==='keepBoth'
                ?<Button variant="secondary" onClick={()=>act(item,'notDuplicate')}>{LABEL.notDuplicate}</Button>
                :<Button variant="secondary" onClick={()=>act(item,'keepBoth')}>{LABEL.keepBoth}</Button>}
            </div>}
        </article>;
      })}
      {cursor&&<Button variant="ghost" onClick={()=>void load(cursor)}>더 보기</Button>}
    </div>}
    {undo&&<div className="review-snackbar duplicates-snackbar" role="status">
      <span>{SAVED[undo.decision]}</span>
      <Button variant="ghost" onClick={revert}><ArrowUturnLeftIcon aria-hidden="true"/>되돌리기</Button>
    </div>}
  </div>;
}
