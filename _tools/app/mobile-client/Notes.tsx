import {useCallback,useEffect,useRef,useState,type MutableRefObject} from 'react';
import {ArrowLeftIcon,ArrowPathIcon,PlusIcon,TrashIcon} from '@heroicons/react/24/outline';
import {Button,IconButton} from './ui';
import {HeaderTools} from './HeaderTools';
import {native,errorText} from './transport';
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
  useEffect(()=>{if(!active||!state.unlocked)return;void sync();const timer=setInterval(()=>{if(document.visibilityState!=='hidden')void sync();},60_000);const resume=()=>{if(document.visibilityState!=='hidden')void sync();};window.addEventListener('lakomics-resume',resume);document.addEventListener('visibilitychange',resume);return()=>{clearInterval(timer);window.removeEventListener('lakomics-resume',resume);document.removeEventListener('visibilitychange',resume);};},[active,state.unlocked,sync]);
  useEffect(()=>{if(!active||!state.notes.some(n=>n.pending))return;const timer=setTimeout(()=>void sync(),2000);return()=>clearTimeout(timer);},[active,state.notes,sync]);
  useEffect(()=>{const leave=()=>{if(document.visibilityState==='hidden')void flush().catch(()=>{});};document.addEventListener('visibilitychange',leave);return()=>document.removeEventListener('visibilitychange',leave);},[flush]);
  const leave=()=>{void flush().then(()=>setSelected(null)).catch(()=>{});};
  useEffect(()=>{backRef.current=()=>{if(!selected)return false;leave();return true;};return()=>{backRef.current=null;};},[selected,flush,backRef]);
  useEffect(()=>{if(!active)return;const toggle=()=>{if(selected)leave();};window.addEventListener('lakomics-sidebar',toggle);return()=>window.removeEventListener('lakomics-sidebar',toggle);},[active,selected,flush]);
  async function open(note:MobileNote){try{await flush();const next={...note,dirty:false,generation:0};current.current=next;setDraft(next);setSelected(note.id);}catch{/* Keep the unsaved editor visible. */}}
  async function create(){try{await flush();const now=new Date().toISOString();const next:Draft={id:crypto.randomUUID(),title:'',body:'',pinned:false,deleted:false,createdAt:now,updatedAt:now,localRevision:0,pending:true,conflict:false,dirty:true,generation:1};current.current=next;setDraft(next);setSelected(next.id);}catch{}}
  function edit(change:Partial<MobileNote>){const old=current.current;if(!old)return;const next={...old,...change,dirty:true,generation:old.generation+1};current.current=next;setDraft(next);}
  const visible=state.notes.filter(n=>n.deleted===trash&&`${n.title}\n${n.body}`.toLocaleLowerCase().includes(query.toLocaleLowerCase())).sort((a,b)=>Number(b.pinned)-Number(a.pinned)||b.updatedAt.localeCompare(a.updatedAt));
  return <section className={`mobile-notes ${selected?'note-open':''}`} style={{display:active?undefined:'none'}} aria-label="메모">
    <HeaderTools active={active&&state.unlocked}><span className="notes-save-state" role="status">{saving?'저장 중':draft?.dirty?'저장 대기':syncing?'동기화 중':state.notes.some(n=>n.pending)?'동기화 대기':''}</span><IconButton label="메모 동기화" icon={ArrowPathIcon} disabled={syncing} onClick={()=>void sync()}/><IconButton label="새 메모" icon={PlusIcon} onClick={()=>void create()}/></HeaderTools>
    {!loaded?<p>메모를 불러오는 중…</p>:!state.unlocked?<form className="notes-unlock" onSubmit={event=>{event.preventDefault();setError('');void native<NotesState>('notesUnlock',{key}).then(next=>{setKey('');accept(next);}).catch(reason=>setError(errorText(reason)));}}><h2>메모 연결</h2><p>PC 메모에서 사용하는 복구 키를 한 번 입력하세요.</p><input type="password" aria-label="메모 복구 키" value={key} autoComplete="off" spellCheck={false} autoCapitalize="none" onChange={event=>setKey(event.target.value)}/><Button type="submit" disabled={key.trim().length!==64}>메모 열기</Button></form>:<>
      <aside className="notes-index"><input aria-label="메모 검색" placeholder="메모 검색" value={query} onChange={event=>setQuery(event.target.value)}/><div className="notes-modes"><Button variant="ghost" aria-pressed={!trash} onClick={()=>setTrash(false)}>메모</Button><Button variant="ghost" aria-pressed={trash} onClick={()=>setTrash(true)}>휴지통</Button></div><div className="notes-list">{visible.map(note=><button key={note.id} aria-current={selected===note.id?'true':undefined} onClick={()=>void open(note)}><strong>{note.pinned?'◆ ':''}{note.title||'제목 없음'}</strong><span>{note.body.slice(0,100)}</span><small>{note.conflict?'충돌 사본 · ':''}{new Date(note.updatedAt).toLocaleDateString()}{note.pending?' · 동기화 대기':''}</small></button>)}{!visible.length&&<p className="muted">{trash?'휴지통이 비어 있습니다.':'아직 메모가 없습니다.'}</p>}</div></aside>
      <div className="notes-editor">{selected&&draft?<><div className="notes-editor-actions"><IconButton label="메모 목록" icon={ArrowLeftIcon} onClick={leave}/><Button variant="ghost" aria-pressed={draft.pinned} onClick={()=>edit({pinned:!draft.pinned})}>고정</Button>{draft.deleted?<Button variant="ghost" onClick={()=>edit({deleted:false})}>복원</Button>:<IconButton label="메모 휴지통으로" icon={TrashIcon} onClick={()=>edit({deleted:true})}/>}</div>{draft.conflict&&<p className="hint">다른 기기의 수정과 겹쳐 두 내용을 모두 보관했습니다.</p>}<input aria-label="메모 제목" placeholder="제목" maxLength={200} value={draft.title} onChange={event=>edit({title:event.target.value})}/><textarea aria-label="메모 내용" placeholder="여기에 메모하세요." value={draft.body} onChange={event=>edit({body:event.target.value})}/></>:<div className="empty-state"><p>메모를 선택하거나 새로 작성하세요.</p><Button onClick={()=>void create()}>새 메모</Button></div>}</div>
    </>}{error&&<div className="notes-error" role="alert">{error}<Button variant="ghost" onClick={()=>void sync()}>다시 시도</Button></div>}
  </section>;
}
