import {useVisibleInterval} from './useVisibleInterval';
import {useCallback,useEffect,useLayoutEffect,useRef,useState,type MutableRefObject} from 'react';
import {ArrowLeftIcon,ArrowPathIcon,MagnifyingGlassIcon,PlusIcon,TrashIcon,XMarkIcon} from '@heroicons/react/24/outline';
import {PinIcon} from './PinIcon';
import {Button,IconButton} from './ui';
import {usePullToRefresh} from './usePullToRefresh';
import {native,errorText} from './transport';
import {useLevelMotion} from './motion';
import './notes.css';
export type MobileNote={id:string;title:string;body:string;pinned:boolean;deleted:boolean;createdAt:string;updatedAt:string;localRevision:number;pending:boolean;conflict:boolean};
type NotesState={unlocked:boolean;notes:MobileNote[];lastSyncedAt?:string|null};
type Draft=MobileNote&{dirty:boolean;generation:number};
export function Notes({active,backRef}:{active:boolean;backRef:MutableRefObject<(()=>boolean)|null>}) {
  const [state,setState]=useState<NotesState>({unlocked:false,notes:[]}),[loaded,setLoaded]=useState(false),[key,setKey]=useState('');
  const [draft,setDraft]=useState<Draft|null>(null),[selected,setSelected]=useState<string|null>(null),[trash,setTrash]=useState(false),[query,setQuery]=useState('');
  const [error,setError]=useState(''),[syncing,setSyncing]=useState(false),[saving,setSaving]=useState(false);
  const current=useRef(draft);current.current=draft;
  const savingRequest=useRef<Promise<void>|null>(null),syncRequest=useRef(false),alive=useRef(true);
  useEffect(()=>{alive.current=true;return()=>{alive.current=false;};},[]);
  const accept=(next:NotesState)=>{if(!alive.current)return;setState(next);setLoaded(true);};
  useEffect(()=>{void native<NotesState>('notesState').then(accept).catch(reason=>{setLoaded(true);setError(errorText(reason));});},[]);
  const flush=useCallback(async()=>{
    if(savingRequest.current){await savingRequest.current;if(current.current?.dirty)await flush();return;}
    if(!current.current?.dirty)return;
    const run=async()=>{setSaving(true);try{
      while(current.current?.dirty){
        const snapshot=current.current;
        const note=await native<MobileNote>('notesSave',{id:snapshot.id,title:snapshot.title,body:snapshot.body,pinned:snapshot.pinned,deleted:snapshot.deleted,expectedRevision:snapshot.localRevision});
        if(!alive.current)return;
        const newer=current.current;
        const next=newer&&newer.id===snapshot.id?{...newer,id:note.id,localRevision:note.localRevision,pending:true,conflict:note.conflict,dirty:newer.generation!==snapshot.generation}:newer;
        current.current=next;setDraft(next);setSelected(id=>id===snapshot.id?note.id:id);
        setState(s=>({...s,notes:[note,...s.notes.filter(n=>n.id!==note.id)]}));setError('');
      }
    }catch(reason){setError(errorText(reason));throw reason;}finally{setSaving(false);}};
    const promise=run();savingRequest.current=promise;try{await promise;}finally{if(savingRequest.current===promise)savingRequest.current=null;}
  },[]);
  const sync=useCallback(async()=>{
    if(syncRequest.current)return;syncRequest.current=true;setSyncing(true);
    try{await flush();const next=await native<NotesState>('notesSync');accept(next);setError('');
      if(current.current&&!current.current.dirty){const note=next.notes.find(n=>n.id===current.current!.id);if(note){const nextDraft={...note,dirty:false,generation:current.current.generation};current.current=nextDraft;setDraft(nextDraft);}}
    }catch(reason){if(alive.current)setError(errorText(reason));}finally{syncRequest.current=false;if(alive.current)setSyncing(false);}
  },[flush]);
  useEffect(()=>{if(!draft?.dirty)return;const timer=setTimeout(()=>{void flush().then(()=>sync()).catch(()=>{});},500);return()=>clearTimeout(timer);},[draft?.generation,flush,sync]);
  const pending=state.notes.some(note=>note.pending);
  const [retryDelay,setRetryDelay]=useState(2000);
  useEffect(()=>{setRetryDelay(2000);},[pending]);
  useVisibleInterval(()=>void sync(),active&&state.unlocked&&!pending?60_000:null,true);
  useVisibleInterval(()=>{
    void sync().finally(()=>{if(alive.current)setRetryDelay(delay=>Math.min(60_000,delay*2));});
  },active&&state.unlocked&&pending?retryDelay:null);
  useEffect(()=>{const leave=()=>{if(document.visibilityState==='hidden')void flush().catch(()=>{});};document.addEventListener('visibilitychange',leave);return()=>document.removeEventListener('visibilitychange',leave);},[flush]);
  const leave=()=>{void flush().then(()=>setSelected(null)).catch(()=>{});};
  useEffect(()=>{backRef.current=()=>{if(selected){leave();return true;}if(trash){setTrash(false);return true;}return false;};return()=>{backRef.current=null;};},[selected,trash,flush,backRef]);
  async function open(note:MobileNote){try{await flush();const next={...note,dirty:false,generation:0};current.current=next;setDraft(next);setSelected(note.id);}catch{/* Keep the unsaved editor visible. */}}
  async function create(){try{await flush();const now=new Date().toISOString();const next:Draft={id:crypto.randomUUID(),title:'',body:'',pinned:false,deleted:false,createdAt:now,updatedAt:now,localRevision:0,pending:true,conflict:false,dirty:true,generation:1};current.current=next;setDraft(next);setSelected(next.id);}catch{}}
  function edit(change:Partial<MobileNote>){const old=current.current;if(!old)return;const next={...old,...change,dirty:true,generation:old.generation+1};current.current=next;setDraft(next);}
  const visible=state.notes.filter(n=>n.deleted===trash&&`${n.title}\n${n.body}`.toLocaleLowerCase().includes((trash?'':query).toLocaleLowerCase())).sort((a,b)=>Number(b.pinned)-Number(a.pinned)||b.updatedAt.localeCompare(a.updatedAt));
  const pinned=trash?[]:visible.filter(n=>n.pinned),recent=trash?visible:visible.filter(n=>!n.pinned);
  const trashed=state.notes.filter(n=>n.deleted).length;
  const status=saving?'저장 중':draft?.dirty?'저장 대기':syncing?'동기화 중':state.notes.some(n=>n.pending)?'동기화 대기':'동기화됨';
  const list=useRef<HTMLDivElement>(null);
  const pull=usePullToRefresh(list,()=>void sync(),syncing,!active||!state.unlocked||!!selected);
  const card=(note:MobileNote)=><button key={note.id} className="note-card" onClick={()=>void open(note)}><strong className={note.title?undefined:'is-untitled'}>{note.title||'제목 없음'}</strong>{note.body&&<span>{note.body.slice(0,240)}</span>}<small>{note.conflict&&<em>충돌 사본</em>}{note.conflict&&' · '}{relativeTime(note.updatedAt)}{note.pending&&<> · <i aria-hidden="true"/>동기화 대기</>}</small></button>;
  const editing=selected&&draft;
  // The editor and the trash are one level below the list; Back returns from the left.
  const section=useRef<HTMLElement>(null);
  const [editorHeight,setEditorHeight]=useState<number>();
  useLayoutEffect(()=>{
    const viewport=window.visualViewport;
    if(!active||!selected||!viewport){setEditorHeight(undefined);return;}
    const update=()=>{
      // Limit the editor to the visible bottom, rather than subtracting the IME
      // twice when Android has already resized the WebView or applied insets.
      const top=section.current?.getBoundingClientRect().top??0;
      setEditorHeight(viewport.scale===1?Math.max(0,viewport.offsetTop+viewport.height-top):undefined);
    };
    update();
    viewport.addEventListener('resize',update);
    viewport.addEventListener('scroll',update);
    window.addEventListener('resize',update);
    return()=>{viewport.removeEventListener('resize',update);viewport.removeEventListener('scroll',update);window.removeEventListener('resize',update);};
  },[active,selected]);
  useLevelMotion(section,active&&loaded&&state.unlocked?(editing?'edit':trash?'trash':'list'):null,(editing?1:0)+(trash?1:0));
  return <section ref={section} className={`mobile-notes ${editing?'note-open':''}`} style={{display:active?undefined:'none',maxHeight:editing?editorHeight:undefined}} aria-label="메모">
    {!loaded?<p className="hint notes-loading">메모를 불러오는 중…</p>:!state.unlocked?<>
      <header className="notes-top"><h1>메모</h1></header>
      <form className="notes-unlock" onSubmit={event=>{event.preventDefault();setError('');void native<NotesState>('notesUnlock',{key}).then(next=>{setKey('');accept(next);}).catch(reason=>setError(errorText(reason)));}}><h2>메모 연결</h2><p>PC 메모에서 사용하는 복구 키를 한 번 입력하세요.</p><input type="password" aria-label="메모 복구 키" value={key} autoComplete="off" spellCheck={false} autoCapitalize="none" onChange={event=>setKey(event.target.value)}/><Button type="submit" variant="primary" disabled={key.trim().length!==64}>메모 열기</Button></form>
    </>:null}
    {loaded&&state.unlocked&&editing&&<>
      <header className="notes-top is-sub"><IconButton label="메모 목록" icon={ArrowLeftIcon} onClick={leave}/><span className="notes-top__space"/><span className="notes-save-state" role="status">{saving?'저장 중':draft.dirty?'저장 대기':'저장됨'}</span>
        {!draft.deleted&&<><IconButton label={draft.pinned?'고정 해제':'고정'} icon={PinIcon} active={draft.pinned} onClick={()=>edit({pinned:!draft.pinned})}/><IconButton label="메모 휴지통으로" icon={TrashIcon} onClick={()=>{edit({deleted:true});leave();}}/></>}</header>
      <div className="notes-editor"><div className="notes-editor__inner">
        {draft.deleted&&<div className="notes-restore"><span>휴지통에 있는 메모입니다.</span><Button variant="ghost" onClick={()=>edit({deleted:false})}>복원</Button></div>}
        {draft.conflict&&<p className="notes-conflict">다른 기기의 수정과 겹쳐 두 내용을 모두 보관했습니다.</p>}
        <input aria-label="메모 제목" placeholder="제목" maxLength={200} value={draft.title} readOnly={draft.deleted} onChange={event=>edit({title:event.target.value})}/>
        <p className="notes-when">{relativeTime(draft.updatedAt)} 수정</p>
        <textarea aria-label="메모 내용" placeholder="여기에 메모하세요." value={draft.body} readOnly={draft.deleted} onChange={event=>edit({body:event.target.value})}/>
      </div></div>
    </>}
    {/* Always mounted once unlocked so its pull-to-refresh gesture stays attached. */}
    <div className="notes-list-view" style={{display:loaded&&state.unlocked&&!editing?undefined:'none'}}>
      {trash
        ?<header className="notes-top is-sub"><IconButton label="메모 목록으로" icon={ArrowLeftIcon} onClick={()=>setTrash(false)}/><h1>휴지통<span className="numeric muted">{trashed}</span></h1></header>
        :<header className="notes-top"><h1>메모</h1><span className="notes-top__space"/><span className="notes-save-state" role="status">{status}</span><IconButton label="메모 동기화" icon={ArrowPathIcon} disabled={syncing} onClick={()=>void sync()}/></header>}
      <div ref={list} className="notes-scroll">
        {pull}
        {trash?<p className="hint notes-trash-hint">열어서 복원할 수 있습니다.</p>:<form className="library-search notes-search" role="search" onSubmit={event=>{event.preventDefault();(document.activeElement as HTMLElement|null)?.blur();}}><MagnifyingGlassIcon aria-hidden="true"/><input aria-label="메모 검색" placeholder="메모 검색" value={query} onChange={event=>setQuery(event.target.value)}/>{query&&<IconButton label="검색어 지우기" icon={XMarkIcon} onClick={()=>setQuery('')}/>}</form>}
        {pinned.length>0&&<><h2 className="notes-label"><PinIcon aria-hidden="true"/>고정됨</h2><div className="notes-grid">{pinned.map(card)}</div></>}
        {recent.length>0&&<>{pinned.length>0&&<h2 className="notes-label">최근</h2>}<div className="notes-grid">{recent.map(card)}</div></>}
        {!visible.length&&<div className="empty-state"><h2>{trash?'휴지통이 비어 있습니다':query?'찾는 메모가 없습니다':'아직 메모가 없습니다'}</h2>{!trash&&!query&&<p>아래 버튼으로 첫 메모를 써 보세요.</p>}</div>}
        {!trash&&trashed>0&&<button className="notes-trash-link" onClick={()=>setTrash(true)}><TrashIcon aria-hidden="true"/>휴지통 <span className="numeric">{trashed}</span></button>}
      </div>
      {!trash&&<Button variant="primary" className="notes-fab" onClick={()=>void create()}><PlusIcon aria-hidden="true"/>새 메모</Button>}
    </div>
    {error&&<div className="notes-error" role="alert">{error}<Button variant="ghost" onClick={()=>void sync()}>다시 시도</Button></div>}
  </section>;
}

/** "N분 전" for recent edits, then the calendar date. */
export function relativeTime(iso:string,now=Date.now()){
  const at=Date.parse(iso);if(!Number.isFinite(at))return '';
  const minutes=Math.floor((now-at)/60_000);
  if(minutes<1)return '방금';
  if(minutes<60)return `${minutes}분 전`;
  if(minutes<1440)return `${Math.floor(minutes/60)}시간 전`;
  if(minutes<10080)return `${Math.floor(minutes/1440)}일 전`;
  return new Date(at).toLocaleDateString();
}
