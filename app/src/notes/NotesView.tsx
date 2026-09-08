import { useEffect, useMemo, useRef, useState, useSyncExternalStore } from "react";
import { useLibrary } from "../library/LibraryContext";
import { ViewToolbar } from "../layout/ViewToolbar";
import { Button } from "../shared/ui/Button";
import { PlusIcon, BookmarkIcon, TrashIcon } from "../shared/ui/ArchiveIcons";
import { NOTES_REFRESH_INTERVAL, notesStore, type Note, type NotesStore } from "./store";
import "./notes.css";

function KeySetup({store}:{store:NotesStore}){
  const [key,setKey]=useState("");const [generated,setGenerated]=useState(false);const [confirmed,setConfirmed]=useState(false);const [busy,setBusy]=useState(false);const [error,setError]=useState("");
  async function generate(){setBusy(true);try{const result=await store.request<{key:string}>("generateKey");setKey(result.key);setGenerated(true);setConfirmed(false);}catch{setError("복구키를 만들지 못했습니다.");}finally{setBusy(false);}}
  return <div className="notes-setup"><span className="notes-eyebrow">PRIVATE NOTES</span><h2>메모 암호화</h2><p>제목과 본문은 이 PC에서 암호화됩니다.<br/>다른 PC에서는 같은 복구키로 메모를 열 수 있습니다.</p>
    <label htmlFor="notes-key">{generated?"새 복구키":"복구키"}</label>
    <textarea id="notes-key" className="ui-input notes-key" value={key} readOnly={generated} spellCheck={false} autoComplete="off" onChange={e=>setKey(e.target.value)} placeholder="다른 PC에서 보관한 64자리 복구키" />
    {generated && <><p className="notes-key-warning">이 키를 별도로 보관해 주세요. 키를 잃으면 서버에서도 복구할 수 없습니다.</p><label className="notes-confirm"><input type="checkbox" checked={confirmed} onChange={e=>setConfirmed(e.target.checked)}/>복구키를 안전한 곳에 보관했습니다</label></>}
    <div className="notes-setup-actions"><Button variant="primary" disabled={busy || key.trim().length!==64 || (generated&&!confirmed)} onClick={async()=>{setBusy(true);await store.unlock(key);setBusy(false);}}>메모 열기</Button><Button variant="ghost" disabled={busy} onClick={()=>void generate()}>처음 사용 · 키 만들기</Button></div>{error&&<p role="alert">{error}</p>}
  </div>;
}

export function NotesView(){const {library}=useLibrary();return library?<NotesWorkspace key={library.root} store={notesStore(library.root)}/>:null;}
export function NotesWorkspace({store}:{store:NotesStore}){
  const state=useSyncExternalStore(store.subscribe,store.snapshot);const [selected,setSelected]=useState<string|null>(null);const [query,setQuery]=useState("");const [trash,setTrash]=useState(false);const [pinned,setPinned]=useState(false);
  const bodyRef=useRef<HTMLTextAreaElement>(null);
  const [backupBusy,setBackupBusy]=useState(false);
  useEffect(()=>{void store.load();},[store]);
  useEffect(()=>{if(!state.unlocked)return;const refresh=()=>{if(!document.hidden)void store.sync(false);};refresh();window.addEventListener("focus",refresh);const timer=setInterval(refresh,NOTES_REFRESH_INTERVAL);return()=>{window.removeEventListener("focus",refresh);clearInterval(timer);};},[store,state.unlocked]);
  const notes=useMemo(()=>state.notes.filter(n=>n.deleted===trash && (!pinned||n.pinned) && `${n.title}\n${n.body}`.toLocaleLowerCase().includes(query.toLocaleLowerCase())).sort((a,b)=>Number(b.pinned)-Number(a.pinned)||b.updatedAt.localeCompare(a.updatedAt)),[state.notes,query,trash,pinned]);
  const note=state.notes.find(n=>n.id===selected && n.deleted===trash)??null;
  const newNote=()=>{setTrash(false);setPinned(false);setQuery("");setSelected(store.create());requestAnimationFrame(()=>bodyRef.current?.focus());};
  function edit(change:Partial<Note>){if(note)store.edit({...note,...change});}
  async function backup(operation:"export"|"import"){setBackupBusy(true);try{await store.backup(operation);}finally{setBackupBusy(false);}}
  const settings=<div className="notes-backup"><Button disabled={backupBusy||state.syncing||state.saving} onClick={()=>void backup("export")}>암호화 백업 저장</Button><Button disabled={backupBusy||state.syncing||state.saving} onClick={()=>void backup("import")}>백업에서 메모 추가</Button><p>같은 복구키의 백업을 새 메모로 추가합니다. 기존 메모는 유지됩니다.</p></div>;
  const status=state.saving?"PC에 저장 중…":state.syncing?"동기화 중…":state.error?"동기화 확인 필요":state.notes.some(n=>n.conflict)?"충돌 확인 필요":state.notes.some(n=>n.pending)?"PC에 저장됨 · 동기화 대기":state.lastSyncedAt?"동기화됨":"PC에 저장됨";
  const navigation=<div className="notes-index"><div className="notes-scopes"><button className="workspace-index-link" aria-current={!trash&&!pinned?"page":undefined} onClick={()=>{setTrash(false);setPinned(false);}}>모든 메모 <span>{state.notes.filter(n=>!n.deleted).length}</span></button><button className="workspace-index-link" aria-current={pinned&&!trash?"page":undefined} onClick={()=>{setTrash(false);setPinned(true);}}>고정</button><button className="workspace-index-link" aria-current={trash?"page":undefined} onClick={()=>{setTrash(true);setPinned(false);}}>휴지통</button></div>
    <div className="notes-list" aria-label="메모 목록">{notes.map(n=><button key={n.id} className={`notes-list-item${selected===n.id?" is-selected":""}`} onClick={()=>setSelected(n.id)} aria-current={selected===n.id?"true":undefined}><span className="notes-list-title">{n.pinned&&<BookmarkIcon aria-label="고정됨"/>}{n.title.trim()||"제목 없는 메모"}{n.conflict&&<span className="notes-conflict-mark" title="충돌 확인 필요">!</span>}</span><span className="notes-list-preview">{n.body.trim().replace(/\s+/g," ")||"내용 없음"}</span><time dateTime={n.updatedAt}>{new Date(n.updatedAt).toLocaleDateString("ko-KR",{month:"short",day:"numeric"})}</time></button>)}{state.unlocked&&!notes.length&&<p className="notes-list-empty">{query?"검색 결과가 없습니다":trash?"휴지통이 비어 있습니다":"메모가 없습니다"}</p>}</div>
  </div>;
  return <div className="notes-workspace" onKeyDown={e=>{if(e.nativeEvent.isComposing)return;if((e.ctrlKey||e.metaKey)&&e.key==="n"&&state.unlocked){e.preventDefault();newNote();}if((e.ctrlKey||e.metaKey)&&e.key==="s"){e.preventDefault();void store.sync();}}}>
    <ViewToolbar title="메모" chrome={{navigation:state.unlocked?navigation:<p className="notes-list-empty">암호화된 개인 메모</p>,search:state.unlocked?{scope:"메모",query,label:"메모 검색",placeholder:"제목과 본문 검색",onApply:setQuery}:undefined,actions:state.unlocked?<Button size="icon" variant="ghost" aria-label="새 메모" onClick={newNote}><PlusIcon/></Button>:undefined,settings:state.unlocked?settings:undefined,summary:"메모 백업과 복원",status:state.unlocked?<span title={state.lastSyncedAt?`마지막 동기화 ${new Date(state.lastSyncedAt).toLocaleString()}`:undefined}>{status}</span>:undefined}}/>
    {state.error&&<div className="notes-error" role="alert"><span>{state.error}</span><Button size="sm" variant="ghost" disabled={state.syncing} onClick={()=>void (state.unlocked?store.sync():store.load())}>다시 시도</Button></div>}
    {!state.ready?<div className="notes-empty">메모를 불러오는 중…</div>:!state.unlocked?<KeySetup store={store}/>:!note?<div className="notes-empty"><span className="notes-eyebrow">NOTES</span><h2>{trash?"휴지통":"메모"}</h2><p>{notes.length?"왼쪽에서 메모를 선택하세요.":query?"검색 결과가 없습니다.":trash?"삭제한 메모가 없습니다.":"아직 작성한 메모가 없습니다."}</p>{!trash&&<Button variant="ghost" onClick={newNote}>＋ 새 메모</Button>}</div>:<article className="notes-editor">
      <div className="notes-editor-actions"><time dateTime={note.updatedAt}>{new Date(note.updatedAt).toLocaleString("ko-KR",{dateStyle:"medium",timeStyle:"short"})}</time><div>{!trash&&<Button size="icon" variant="ghost" aria-label={note.pinned?"고정 해제":"메모 고정"} aria-pressed={note.pinned} onClick={()=>edit({pinned:!note.pinned})}><BookmarkIcon/></Button>}{trash?<Button size="sm" onClick={()=>{edit({deleted:false});setTrash(false);}}>복원</Button>:<Button size="icon" variant="ghost" aria-label="메모를 휴지통으로" onClick={()=>{edit({deleted:true});setSelected(null);}}><TrashIcon/></Button>}<Button size="sm" variant="ghost" disabled={state.syncing||state.saving} onClick={()=>void store.sync()}>동기화</Button></div></div>
      {note.conflict&&<div className="notes-conflict" role="status"><p>다른 기기에서도 수정됐습니다. 이 메모를 복사본으로 남기고 서버 버전을 불러올 수 있습니다.</p><Button size="sm" disabled={state.syncing||state.saving} onClick={()=>void store.resolve(note,true)}>내 내용 보관 후 서버 버전 불러오기</Button></div>}
      <input className="notes-title" aria-label="메모 제목" placeholder="제목 없는 메모" maxLength={200} value={note.title} readOnly={trash} onChange={e=>edit({title:e.target.value})}/>
      <textarea ref={bodyRef} className="notes-body" aria-label="메모 본문" placeholder="여기에 적어보세요…" value={note.body} readOnly={trash} spellCheck={false} onChange={e=>edit({body:e.target.value})}/>
      <footer className="notes-editor-footer"><span>{note.body.length.toLocaleString()}자</span><span>자동 저장 · 암호화된 메모</span></footer>
    </article>}
  </div>;
}
