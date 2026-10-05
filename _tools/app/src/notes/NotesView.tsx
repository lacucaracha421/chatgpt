import { BusyLabel } from "../shared/ui/BusyLabel";
import { displayDateTime } from "../shared/displayDate";
import { useCallback, useEffect, useMemo, useRef, useState, useSyncExternalStore, type CSSProperties } from "react";
import { ArrowLeftIcon, ArrowPathIcon, ArrowUturnLeftIcon, ChevronDownIcon, DocumentTextIcon, EllipsisHorizontalIcon, LockClosedIcon, PlusIcon, TrashIcon } from "@heroicons/react/24/outline";
import { useLibrary } from "../library/LibraryContext";
import { ViewToolbar } from "../layout/ViewToolbar";
import { Button } from "../shared/ui/Button";
import { IconButton } from "../shared/ui/IconButton";
import { PinIcon, PinSolidIcon } from "../shared/ui/PinIcon";
import { Menu, type MenuItem } from "../shared/ui/Menu";
import { SegmentedControl, type SegmentedOption } from "../shared/ui/SegmentedControl";
import { useSectionDrop } from "../shared/ui/useSectionDrop";
import { SecretEditor, SecretGate } from "./SecretNote";
import { checklistMarkdown, labelKey, NOTE_COLORS, NOTE_LIMITS, noteColorValue, noteLimitProblem, normalizeLabel, type ChecklistItem, type NoteKind } from "./model";
import { isSecret, NOTES_REFRESH_INTERVAL, noteKind, notesStore, PIN_REQUIRED_TEXT, type Note, type NotesStore } from "./store";
import { genericView, LEDGER } from "./ledger/model";
import { LedgerView } from "./ledger/LedgerView";
import { hiddenLedgerMonths } from "./ledger/model";
import { NoteMasonry } from "./NoteBoard";
import { NOTE_KIND_DEFINITIONS, type NoteKindFilter } from "./noteFilters";
import { useNoteUndo, type NoteUndoField, type NoteUndoValue } from "./useNoteUndo";
import { MemoEditor } from "./memo/MemoEditor";
import { memoBody, memoItems, memoMode, parseMemo, switchMode } from "./memo/memoModel";
import { useBackHandler } from "../shared/navigation/BackNavigation";
import { noteMatches, sortNotes } from "./noteList";
import QRCode from "qrcode";
import "./notes.css";

export { noteMatches } from "./noteList";

export function RecoveryKeyReveal({store}:{store:NotesStore}){
  const [key,setKey]=useState<string|null>(null);const [qr,setQr]=useState("");const [error,setError]=useState("");const [needPin,setNeedPin]=useState(false);const [pin,setPin]=useState("");
  async function reveal(){setError("");try{const next=(await store.request<{key:string}>("recoveryKey")).key;setQr(await QRCode.toDataURL(next,{margin:2,width:220,errorCorrectionLevel:"M"}));setKey(next);setNeedPin(false);}catch(e){if(e===PIN_REQUIRED_TEXT)setNeedPin(true);else setError(e instanceof Error?e.message:String(e));}}
  // With a secret-note PIN set, the recovery key (which can reset that PIN) needs the PIN too.
  async function unlockAndReveal(){setError("");const failure=await store.openSecrets("secretUnlock",{pin});setPin("");if(failure)setError(failure);else await reveal();}
  function hide(){setKey(null);setQr("");}
  return <>{key===null
    ?needPin?<form className="notes-recovery-pin" onSubmit={e=>{e.preventDefault();void unlockAndReveal();}}><label htmlFor="notes-recovery-pin">암호 메모 PIN</label><input id="notes-recovery-pin" className="ui-input notes-secret-gate__pin" type="password" inputMode="numeric" autoComplete="off" maxLength={8} value={pin} onChange={e=>setPin(e.target.value.replace(/\D/g,""))}/><p>복구키를 보려면 이 PC의 암호 메모 PIN을 입력하세요.</p><Button type="submit" disabled={pin.length<4}>확인 후 복구키 보기</Button></form>
    :<Button onClick={()=>void reveal()}>복구키 보기</Button>
    :<><label htmlFor="notes-recovery-key">복구키</label>
      {qr&&<img className="notes-recovery-qr" src={qr} alt="복구키 QR 코드" width={220} height={220}/>}
      <textarea id="notes-recovery-key" className="ui-input notes-key" value={key} readOnly spellCheck={false} autoComplete="off"/>
      <p>휴대폰 카메라로 QR을 찍어 나온 값을 모바일 메모의 복구키 칸에 붙여넣으세요. 다른 사람이 보지 않는 곳에서 열고, 따로 보관해 주세요.</p>
      <Button onClick={hide}>숨기기</Button></>}
    {error&&<p role="alert">{error}</p>}</>;
}

function KeySetup({store}:{store:NotesStore}){
  const [key,setKey]=useState("");const [generated,setGenerated]=useState(false);const [confirmed,setConfirmed]=useState(false);const [busy,setBusy]=useState(false);const [error,setError]=useState("");
  async function generate(){setBusy(true);try{const result=await store.request<{key:string}>("generateKey");setKey(result.key);setGenerated(true);setConfirmed(false);}catch{setError("복구키를 만들지 못했습니다.");}finally{setBusy(false);}}
  return <div className="notes-setup"><h2>메모 암호화</h2><p>제목과 본문은 이 PC에서 암호화됩니다.<br/>다른 PC에서는 같은 복구키로 메모를 열 수 있습니다.</p>
    <label htmlFor="notes-key">{generated?"새 복구키":"복구키"}</label>
    <textarea id="notes-key" className="ui-input notes-key" value={key} readOnly={generated} spellCheck={false} autoComplete="off" onChange={e=>setKey(e.target.value)} placeholder="다른 PC에서 보관한 64자리 복구키" />
    {generated && <><p className="notes-key-warning">이 키를 별도로 보관해 주세요. 키를 잃으면 서버에서도 복구할 수 없습니다.</p><label className="notes-confirm"><input type="checkbox" checked={confirmed} onChange={e=>setConfirmed(e.target.checked)}/>복구키를 안전한 곳에 보관했습니다</label></>}
    <div className="notes-setup-actions"><Button variant="primary" disabled={busy || key.trim().length!==64 || (generated&&!confirmed)} onClick={async()=>{setBusy(true);await store.unlock(key);setBusy(false);}}>메모 열기</Button><Button variant="ghost" disabled={busy} onClick={()=>void generate()}>처음 사용 · 키 만들기</Button></div>{error&&<p role="alert">{error}</p>}
  </div>;
}

/** Idle time after which revealed secret notes lock again (the backend enforces the same). */
export const SECRET_IDLE_MS = 5 * 60_000;
export const SECRET_TOUCH_MS = 60_000;
type Scope = "all" | "pinned" | "archive" | "trash";
const tint = (color: string | null | undefined) => { const value = noteColorValue(color); return value ? ({ "--note-tint": value } as CSSProperties) : undefined; };

function LabelEditor({ labels, suggestions, onChange }: { labels: string[]; suggestions: string[]; onChange: (labels: string[]) => void }) {
  const [adding, setAdding] = useState(false);
  const [text, setText] = useState("");
  function commit(close: boolean) {
    const label = normalizeLabel(text);
    if (label && labels.length < NOTE_LIMITS.labels && !labels.some((entry) => labelKey(entry) === labelKey(label))) onChange([...labels, label]);
    setText("");
    if (close) setAdding(false);
  }
  return (
    <div className="notes-labels" aria-label="라벨">
      {labels.map((label) => (
        <span key={label} className="notes-label-chip">{label}
          <button type="button" aria-label={`${label} 라벨 빼기`} onClick={() => onChange(labels.filter((entry) => entry !== label))}>×</button>
        </span>
      ))}
      {adding ? (
        <>
          <input className="notes-label-input" aria-label="라벨 추가" list="notes-label-options" autoFocus maxLength={NOTE_LIMITS.labelChars} value={text}
            onChange={(event) => setText(event.target.value)} onBlur={() => commit(true)}
            onKeyDown={(event) => { if (event.nativeEvent.isComposing) return; if (event.key === "Enter") { event.preventDefault(); commit(false); } else if (event.key === "Escape") { setText(""); setAdding(false); } }} />
          <datalist id="notes-label-options">{suggestions.filter((entry) => !labels.some((label) => labelKey(label) === labelKey(entry))).map((entry) => <option key={entry} value={entry} />)}</datalist>
        </>
      ) : labels.length < NOTE_LIMITS.labels && <button type="button" className="notes-label-add" onClick={() => setAdding(true)}>＋ 라벨</button>}
    </div>
  );
}

function KeyringLocked({ store, busy }: { store: NotesStore; busy: boolean }) {
  return <div className="notes-setup"><h2>키링이 잠겨 있습니다</h2>
    <p>메모 암호화 키는 시스템 키링에 있습니다.<br />로그인 암호로 키링을 열면 메모를 볼 수 있습니다.</p>
    <div className="notes-setup-actions"><Button variant="primary" disabled={busy} onClick={() => void store.unlockKeyring()}>키링 잠금 해제</Button></div></div>;
}

/** `noteId` opens that note on arrival (Home's pinned notes). */
export function NotesView({noteId}:{noteId?:string}={}){const {library}=useLibrary();return library?<NotesWorkspace key={library.root} store={notesStore(library.root)} initialNoteId={noteId}/>:null;}
export function NotesWorkspace({store,initialNoteId}:{store:NotesStore;initialNoteId?:string}){
  const state=useSyncExternalStore(store.subscribe,store.snapshot);
  const [selected,setSelected]=useState<string|null>(initialNoteId??null);const [query,setQuery]=useState("");const [scope,setScope]=useState<Scope>("all");const [label,setLabel]=useState<string|null>(null);const [kindFilter,setKindFilter]=useState<NoteKindFilter>("all");
  const [creatingSecret,setCreatingSecret]=useState(false);const [keyringBusy,setKeyringBusy]=useState(false);
  const titleRef=useRef<HTMLInputElement>(null);
  const boardRef=useRef<HTMLDivElement>(null);const listScrollTop=useRef(0);const [recoveryOpen,setRecoveryOpen]=useState(false);
  const [editing,setEditing]=useState(false);
  const editTimer=useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  useEffect(()=>()=>clearTimeout(editTimer.current),[]);
  const [backupBusy,setBackupBusy]=useState(false);
  const [syncDelayed,setSyncDelayed]=useState(false);
  useEffect(()=>{
    if(!state.syncing){setSyncDelayed(false);return;}
    const timer=setTimeout(()=>setSyncDelayed(true),300);
    return()=>clearTimeout(timer);
  },[state.syncing]);
  useEffect(()=>{void store.load();},[store]);
  useEffect(()=>{if(!state.unlocked)return;const refresh=()=>{if(!document.hidden)void store.sync(false);};refresh();window.addEventListener("focus",refresh);const timer=setInterval(refresh,NOTES_REFRESH_INTERVAL);return()=>{window.removeEventListener("focus",refresh);clearInterval(timer);};},[store,state.unlocked]);
  // Leaving the window or the Notes screen finishes the work: one sync of what was edited.
  useEffect(()=>{
    const finish=()=>{void store.finish();};
    const hidden=()=>{if(document.hidden)finish();};
    window.addEventListener("blur",finish);document.addEventListener("visibilitychange",hidden);
    return()=>{window.removeEventListener("blur",finish);document.removeEventListener("visibilitychange",hidden);finish();};
  },[store]);
  // Opening Notes is the one user action allowed to show the keyring password dialog.
  const keyringPrompted=useRef(false);
  useEffect(()=>{if(!state.keyringLocked||keyringPrompted.current)return;keyringPrompted.current=true;setKeyringBusy(true);void store.unlockKeyring().finally(()=>setKeyringBusy(false));},[store,state.keyringLocked]);
  // Secret notes lock again after 5 idle minutes, when the window is hidden, and when Notes closes.
  const revealed=state.notes.some(n=>isSecret(n)&&!n.redacted);
  const lockSecrets=useCallback(()=>{void store.lockSecrets();},[store]);
  useEffect(()=>{
    if(!revealed)return;
    let timer=setTimeout(lockSecrets,SECRET_IDLE_MS);
    let touched=Date.now();
    // Activity also keeps the backend session alive (at most once a minute).
    const bump=()=>{clearTimeout(timer);timer=setTimeout(lockSecrets,SECRET_IDLE_MS);if(Date.now()-touched>=SECRET_TOUCH_MS){touched=Date.now();void store.touchSecrets();}};
    const hidden=()=>{if(document.hidden)lockSecrets();};
    window.addEventListener("pointerdown",bump);window.addEventListener("keydown",bump);document.addEventListener("visibilitychange",hidden);
    return()=>{clearTimeout(timer);window.removeEventListener("pointerdown",bump);window.removeEventListener("keydown",bump);document.removeEventListener("visibilitychange",hidden);};
  },[revealed,lockSecrets,store]);
  useEffect(()=>{if(!state.moved)return;if(selected===state.moved.from)setSelected(state.moved.to);store.clearMoved();},[state.moved,selected,store]);
  useEffect(()=>()=>{void store.lockSecrets();},[store]);
  const notesRef=useRef(state.notes);notesRef.current=state.notes;
  const previous=useRef<string|null>(null);
  useEffect(()=>{
    const before=notesRef.current.find(n=>n.id===previous.current);const now=notesRef.current.find(n=>n.id===selected);
    // Closing a note or switching to another one is the moment to sync it.
    if(previous.current&&previous.current!==selected)void store.finish();
    previous.current=selected;
    // Closing a secret note locks; moving straight to another secret note keeps the session.
    if(before&&isSecret(before)&&before.id!==selected&&!(now&&isSecret(now)))lockSecrets();
  },[selected,lockSecrets,store]);

  const allLabels=useMemo(()=>{const map=new Map<string,{label:string;count:number}>();for(const n of state.notes)if(!n.deleted)for(const l of n.labels??[]){const k=labelKey(l);const e=map.get(k);if(e)e.count++;else map.set(k,{label:l,count:1});}return [...map.values()].sort((a,b)=>a.label.localeCompare(b.label,"ko"));},[state.notes]);
  // Ledger month notes are internal to their ledger (design §4.1): never listed, searched or counted.
  const hiddenMonths=useMemo(()=>hiddenLedgerMonths(state.notes),[state.notes]);
  const notes=useMemo(()=>sortNotes(state.notes.filter(n=>!hiddenMonths.has(n.id)&&(scope==="trash"?n.deleted:!n.deleted&&(scope==="archive"?!!n.archived:!n.archived)&&(scope!=="pinned"||n.pinned))&&(!label||(n.labels??[]).some(l=>labelKey(l)===labelKey(label)))&&(kindFilter==="all"||(noteKind(n)==="checklist"?"text":noteKind(n))===kindFilter)&&noteMatches(n,query))),[state.notes,hiddenMonths,query,scope,label,kindFilter]);
  const trash=scope==="trash";
  const found=state.notes.find(n=>n.id===selected && n.deleted===trash)??null;
  // A ledger opens its own screen; in trash, older schemas and orphan month notes it stays read-only.
  const ledgerOpen=!!found&&found.type===LEDGER&&!found.readOnly&&!trash;
  const note=ledgerOpen?found:genericView(found);
  const kind=note?noteKind(note):"text";
  const editable=!!note&&!trash&&!note.readOnly&&!note.redacted;
  const select=(id:string|null)=>{setCreatingSecret(false);setSelected(id);setLimitError(null);};
  const open=useCallback((id:string)=>{listScrollTop.current=boardRef.current?.scrollTop??0;setCreatingSecret(false);setSelected(id);setLimitError(null);},[]);
  /** Closes the editor panel (or the ledger screen) and returns focus to the note's card. */
  function close(){const id=selected;select(null);if(id)requestAnimationFrame(()=>{if(boardRef.current)boardRef.current.scrollTop=listScrollTop.current;document.querySelector<HTMLElement>(`.notes-card[data-note-id="${CSS.escape(id)}"]`)?.focus();});}
  useBackHandler(()=>{if(recoveryOpen){setRecoveryOpen(false);return true;}close();return true;},10,!!selected||creatingSecret||recoveryOpen);
  function newNote(kind:NoteKind="text"){
    if(kind==="secret"&&!revealed){setScope("all");setLabel(null);setQuery("");setSelected(null);setCreatingSecret(true);return;}
    setScope("all");setLabel(null);setQuery("");select(store.create(kind));
    if(kind!=="text")requestAnimationFrame(()=>titleRef.current?.focus());
  }
  /** Only one 가계부: opens the existing one, restores it from 휴지통 if that is the only one, or creates it pinned. */
  function openLedger(){
    const ledgers=state.notes.filter(n=>n.type===LEDGER).sort((a,b)=>a.createdAt.localeCompare(b.createdAt));
    const existing=ledgers.find(n=>!n.deleted)??ledgers.find(n=>n.deleted);
    if(existing?.deleted)store.edit({...existing,deleted:false});
    setScope("all");setLabel(null);setQuery("");select(existing?existing.id:store.create(LEDGER));
  }
  const memoSource=note?(kind==="checklist"?checklistMarkdown(note.items??[])||"- [ ]":note.body):"";
  const memoEditingMode=memoMode(memoSource);
  const [limitError,setLimitError]=useState<string|null>(null);
  const applyUndo=useRef<(field:NoteUndoField,value:NoteUndoValue)=>void>(()=>{});
  const noteUndo=useNoteUndo(note?.id??null,(field,value)=>applyUndo.current(field,value));
  function edit(change:Partial<Note>,historyField?:NoteUndoField){
    if(!note)return false;
    const next:Note=kind==="checklist"?{...note,type:"text",body:memoSource,items:undefined,...change}:{...note,...change};
    const problem=noteLimitProblem(next);setLimitError(problem);if(problem)return false;
    if(historyField){
      const before:NoteUndoValue=historyField==="checklist"?(note.items??[]):historyField==="title"?note.title:memoSource;
      const after:NoteUndoValue=historyField==="checklist"?(next.items??[]):historyField==="title"?next.title:next.body;
      noteUndo.record(historyField,before,after);
    }
    setEditing(true);clearTimeout(editTimer.current);editTimer.current=setTimeout(()=>setEditing(false),1200);store.edit(next,historyField==="body"||historyField==="title");return true;
  }
  applyUndo.current=(field,value)=>edit(field==="checklist"?{items:value as ChecklistItem[]}:field==="title"?{title:value as string}:{type:"text",items:undefined,body:value as string});
  async function backup(operation:"export"|"import"){setBackupBusy(true);try{await store.backup(operation);}finally{setBackupBusy(false);}}
  const status=state.error?"저장·동기화 확인 필요":state.notes.some(n=>n.conflict)?"충돌 확인 필요":editing?"편집 중":state.notes.some(n=>n.pending)?"PC에 저장됨 · 동기화 대기":state.lastSyncedAt?"동기화됨":"PC에 저장됨";
  const newItems:MenuItem[]=[{id:"text",label:"메모",onSelect:()=>newNote("text")},{id:"secret",label:"암호 메모",onSelect:()=>newNote("secret")},{id:"ledger",label:"가계부",onSelect:openLedger}];
  const colorItems:MenuItem[]=note?[{id:"none",label:"기본",group:"color",selected:!noteColorValue(note.color),onSelect:()=>edit({color:null})},...NOTE_COLORS.map(c=>({id:c.key,label:c.label,group:"color",selected:note.color===c.key,icon:<span className="notes-swatch" style={{background:c.value}} aria-hidden="true"/>,onSelect:()=>edit({color:c.key})}))]:[];
  // Archive sits in the ⋯ menu next to 휴지통, away from the everyday actions.
  const moreItems:MenuItem[]=note&&!trash?[
    ...((kind==="text"||kind==="checklist")&&!note.readOnly?[{id:"conceal",label:note.concealed?"목록에서 내용 보이기":"목록에서 내용 숨기기",onSelect:()=>edit({concealed:!note.concealed})}]:[]),
    {id:"archive",label:note.archived?"보관 해제":"보관함으로 보내기",onSelect:()=>edit({archived:!note.archived})}]:[];
  const colorValue=note?noteColorValue(note.color):null;
  const notesSectionTitle=query.trim()?"검색 결과":label??({all:"모든 메모",pinned:"고정",archive:"보관함",trash:"휴지통"} as const)[scope];
  const kindOptions:SegmentedOption<NoteKindFilter>[]=[{value:"all",label:"전체"},...NOTE_KIND_DEFINITIONS.filter(([value])=>value!=="checklist").map(([value,label])=>({value,label}))];
  const scopeCounts={
    all:state.notes.filter(n=>!n.deleted&&!n.archived&&!hiddenMonths.has(n.id)).length,
    pinned:state.notes.filter(n=>!n.deleted&&!n.archived&&!hiddenMonths.has(n.id)&&n.pinned).length,
    archive:state.notes.filter(n=>!n.deleted&&n.archived&&!hiddenMonths.has(n.id)).length,
    trash:state.notes.filter(n=>n.deleted&&!hiddenMonths.has(n.id)).length,
  };
  const menuCount=(value:number)=><span className="notes-view-menu-count" aria-hidden="true">{value.toLocaleString()}</span>;
  const viewItems:MenuItem[]=[
    {id:"scope-all",label:"모든 메모",selected:scope==="all"&&!label,icon:menuCount(scopeCounts.all),onSelect:()=>{setScope("all");setLabel(null);}},
    {id:"scope-pinned",label:"고정",selected:scope==="pinned"&&!label,icon:menuCount(scopeCounts.pinned),onSelect:()=>{setScope("pinned");setLabel(null);}},
    {id:"scope-archive",label:"보관함",selected:scope==="archive"&&!label,icon:menuCount(scopeCounts.archive),onSelect:()=>{setScope("archive");setLabel(null);}},
    {id:"scope-trash",label:"휴지통",selected:scope==="trash"&&!label,icon:menuCount(scopeCounts.trash),onSelect:()=>{setScope("trash");setLabel(null);}},
    {id:"labels-heading",label:"라벨",disabled:true,onSelect:()=>{}},
    ...allLabels.map((entry):MenuItem=>({id:`label-${labelKey(entry.label)}`,label:entry.label,selected:!!label&&labelKey(label)===labelKey(entry.label),icon:menuCount(entry.count),onSelect:()=>{setLabel(entry.label);if(scope==="trash"||scope==="pinned")setScope("all");}})),
    ...(label?[{id:"label-clear",label:"라벨 해제",onSelect:()=>setLabel(null)}]:[]),
    {id:"backup-heading",label:"백업",disabled:true,onSelect:()=>{}},
    {id:"backup-export",label:"암호화 백업 저장",disabled:backupBusy||state.syncing||state.saving,onSelect:()=>void backup("export")},
    {id:"backup-import",label:"백업에서 메모 추가",disabled:backupBusy||state.syncing||state.saving,onSelect:()=>void backup("import")},
    {id:"backup-recovery",label:"복구키 보기",onSelect:()=>setRecoveryOpen(true)},
  ];
  const viewLabel=label?`라벨: ${label}`:scope==="all"?"보기":({pinned:"고정",archive:"보관함",trash:"휴지통"} as const)[scope];
  const body=!note?null:isSecret(note)&&state.secretLocked&&!note.redacted?<SecretGate key={`resume-${note.id}`} store={store} onOpened={()=>store.resumeSecretSaves()}/>
    :isSecret(note)?(note.redacted?<SecretGate key={note.id} store={store} onOpened={()=>void store.refresh()}/>
      :<SecretEditor fields={note.fields??[]} memo={note.memo??""} readOnly={!editable} onChange={change=>edit(change)}/>)
    :<MemoEditor noteId={note.id} body={memoSource} readOnly={!editable} onChange={(body,structural)=>{
      if(structural)noteUndo.breakGroup();
      const saved=edit({type:"text",items:undefined,body},"body");
      if(structural)noteUndo.breakGroup();
      return saved;
    }}/>;
  const memoTasks=memoItems(parseMemo(memoSource)).filter(item=>item.task);
  const footer=!note?null:isSecret(note)?"암호 메모 · 이 PC의 PIN으로 잠김":memoEditingMode==="todo"?`${memoTasks.filter(item=>item.done).length}/${memoTasks.length} 완료`:`${note.body.length.toLocaleString()}자`;
  const pinnedNotes=scope==="all"?notes.filter(n=>n.pinned):[];
  const otherNotes=pinnedNotes.length?notes.filter(n=>!n.pinned):notes;
  const sectionDrop=useSectionDrop({label:"메모 종류", options:kindOptions, value:kindFilter, onChange:setKindFilter, trailing:<>
      <Menu label="새 메모" items={newItems} trigger={<PlusIcon aria-hidden="true"/>} triggerClassName="notes-new-trigger" />
      <Menu label={viewLabel==="보기"?"보기 · 모든 메모":`보기 · ${viewLabel}`} items={viewItems} trigger={<><span>{viewLabel}</span>{viewLabel==="보기"&&<span className="notes-view-trigger__count">{scopeCounts.all.toLocaleString()}</span>}<ChevronDownIcon aria-hidden="true"/></>} triggerClassName="notes-view-trigger" />
    </>}, state.unlocked&&!selected&&!creatingSecret);
  const board=<div ref={boardRef} className="notes-board">
    {sectionDrop.inline}
    <div className="notes-board__items" aria-label="메모 목록">
    {pinnedNotes.length>0&&<><h2 className="workspace-section-label notes-board__label">고정됨</h2><NoteMasonry notes={pinnedNotes} all={state.notes} selected={selected} onOpen={open}/>
      {otherNotes.length>0&&<h2 className="workspace-section-label notes-board__label">최근</h2>}</>}
    {otherNotes.length>0&&<NoteMasonry notes={otherNotes} all={state.notes} selected={selected} onOpen={open}/>}
    {!!state.unreadable&&<p className="notes-list-empty" role="status">읽을 수 없는 메모 {state.unreadable}개는 목록에서 뺐습니다.</p>}
    {!notes.length&&<div className="notes-empty"><DocumentTextIcon className="notes-empty__icon" aria-hidden="true"/><p>{query?"검색 결과 없음":trash?"휴지통 비어 있음":scope==="archive"?"보관함 비어 있음":"메모 없음"}</p>{!trash&&scope!=="archive"&&!query&&<Button variant="ghost" onClick={()=>newNote()}>＋ 새 메모</Button>}</div>}
    </div>
  </div>;
  const listView=<div className="notes-list-view">{board}</div>;
  const editor=!note?null:<article className={`notes-editor${noteColorValue(note.color)?" has-tint":""}`} style={tint(note.color)}>
      <div className="notes-editor-actions"><div className="notes-editor-actions__leading"><Button variant="quiet" className="notes-back-button" aria-label="메모 닫기" onClick={close}><ArrowLeftIcon aria-hidden="true"/>메모</Button><time dateTime={note.updatedAt}>{displayDateTime(note.updatedAt, new Date(), { withTime: true })}</time></div><div>
        <Button variant="quiet" className="notes-undo-button" disabled={!noteUndo.canUndo} onClick={()=>{noteUndo.undo();}}><ArrowUturnLeftIcon aria-hidden="true"/>되돌리기</Button>
        {!trash&&isSecret(note)&&!note.redacted&&<Button size="icon" variant="ghost" aria-label="지금 잠그기" onClick={lockSecrets}><LockClosedIcon/></Button>}
        {!trash&&<IconButton label={note.pinned?"고정 해제":"고정"} icon={PinIcon} activeIcon={PinSolidIcon} active={!!note.pinned} onClick={()=>edit({pinned:!note.pinned})}/>}
        {!trash&&<Menu label="메모 색상" items={colorItems} trigger={<span className={`notes-color-dot${colorValue?"":" is-empty"}`} style={colorValue?{background:colorValue}:undefined} aria-hidden="true"/>} triggerClassName="notes-menu-trigger"/>}
        <span className="notes-editor-actions__gap" aria-hidden="true"/>
        {moreItems.length>0&&<Menu label="메모 더보기" items={moreItems} trigger={<EllipsisHorizontalIcon aria-hidden="true"/>} triggerClassName="notes-menu-trigger"/>}
        {trash?<Button size="sm" onClick={()=>{edit({deleted:false});setScope("all");}}>복원</Button>:<Button size="icon" variant="ghost" aria-label="메모를 휴지통으로" onClick={()=>{edit({deleted:true});select(null);}}><TrashIcon/></Button>}
      </div></div>
      {note.conflict&&<div className="notes-conflict" role="status"><p>다른 기기 수정과 충돌했습니다.</p><Button size="sm" disabled={state.syncing||state.saving} onClick={()=>void store.resolve(note,true)}>내 내용 보관 후 서버 버전 불러오기</Button></div>}
      {note.conflictCopy&&<div className="notes-conflict" role="status"><p>충돌한 내용을 두 개의 메모로 보관했습니다.</p><Button size="sm" variant="ghost" onClick={()=>void store.dismissConflictCopy(note.id)}>확인</Button></div>}
      {limitError&&<p className="notes-limit" role="alert">{limitError}</p>}
      {isSecret(note)&&state.secretLocked&&!note.redacted&&<p className="notes-readonly" role="status">저장하지 못한 변경이 있습니다. PIN을 입력해 이어서 저장합니다.</p>}
      {note.readOnly&&<p className="notes-readonly" role="status">새 버전에서 만든 메모입니다. 업데이트 후 편집할 수 있습니다.</p>}
      <div className={isSecret(note)?undefined:"notes-title-row"}>
      <input ref={titleRef} className="notes-title" aria-label="메모 제목" placeholder={isSecret(note)?"암호 메모 제목":"제목 없는 메모"} maxLength={NOTE_LIMITS.title} value={note.title} readOnly={trash||!!note.readOnly} onChange={e=>edit({title:e.target.value},"title")}/>
        {!isSecret(note)&&(editable?<SegmentedControl label="메모 방식" options={[{value:"text",label:"글"},{value:"todo",label:"할 일"}]} value={memoEditingMode} onChange={mode=>{
          if(mode===memoEditingMode)return;
          noteUndo.breakGroup();edit({type:"text",items:undefined,body:memoBody(switchMode(parseMemo(memoSource),mode))},"body");noteUndo.breakGroup();
        }}/>:<span>{memoEditingMode==="todo"?"할 일":"글"}</span>)}
      </div>
      {!note.redacted&&(editable||(note.labels??[]).length>0)&&<LabelEditor key={note.id} labels={note.labels??[]} suggestions={allLabels.map(l=>l.label)} onChange={labels=>editable&&edit({labels})}/>}
      {body}
      <footer className="notes-editor-footer"><span>{footer}</span>
        <Button size="icon" variant="ghost" className={`notes-sync${syncDelayed?" is-syncing":""}${state.error?" is-error":""}`} aria-label="동기화" aria-busy={state.syncing} disabled={state.syncing||state.saving} onClick={()=>void store.sync()}><ArrowPathIcon aria-hidden="true"/></Button></footer>
    </article>;
  const secretCreation=creatingSecret?<article className="notes-editor notes-editor--gate"><div className="notes-editor-actions"><div className="notes-editor-actions__leading"><Button variant="quiet" className="notes-back-button" aria-label="메모 닫기" onClick={close}><ArrowLeftIcon aria-hidden="true"/>메모</Button></div></div><SecretGate store={store} onOpened={()=>{setCreatingSecret(false);select(store.create("secret"));requestAnimationFrame(()=>titleRef.current?.focus());}} onCancel={close}/></article>:null;
  const main=!state.ready?<div className="notes-empty notes-loading" aria-busy="true"><DocumentTextIcon className="notes-empty__icon" aria-hidden="true"/></div>
    :state.keyringLocked?<KeyringLocked store={store} busy={keyringBusy}/>
    :!state.unlocked?<KeySetup store={store}/>
    :ledgerOpen&&note&&!creatingSecret?<LedgerView key={note.id} store={store} ledgerId={note.id} actions={<>
        <Button variant="quiet" className="notes-back-button" aria-label="메모 닫기" onClick={close}><ArrowLeftIcon aria-hidden="true"/>메모</Button>
        <IconButton label={note.pinned?"고정 해제":"고정"} icon={PinIcon} activeIcon={PinSolidIcon} active={!!note.pinned} onClick={()=>edit({pinned:!note.pinned})}/>
        <Menu label="메모 더보기" items={moreItems} trigger={<EllipsisHorizontalIcon aria-hidden="true"/>} triggerClassName="notes-menu-trigger"/>
        <Button size="icon" variant="ghost" aria-label="메모를 휴지통으로" onClick={()=>{edit({deleted:true});select(null);}}><TrashIcon/></Button></>}>
        {note.conflict&&<div className="notes-conflict ledger-banner" role="status"><p>다른 기기 수정과 충돌했습니다.</p><Button size="sm" disabled={state.syncing||state.saving} onClick={()=>void store.resolve(note,true)}>내 내용 보관 후 서버 버전 불러오기</Button></div>}
        {limitError&&<p className="notes-limit ledger-banner" role="alert">{limitError}</p>}
      </LedgerView>
    :selected&&editor?<div className="notes-main notes-main--editor">{editor}</div>
    :secretCreation?<div className="notes-main notes-main--editor">{secretCreation}</div>
    :listView;
  const recoverySurface=recoveryOpen?<div className="notes-recovery-backdrop" role="presentation"><section className="notes-recovery-surface" role="dialog" aria-modal="true" aria-label="복구키"><div className="notes-recovery-surface__head"><h2>복구키</h2><Button variant="quiet" onClick={()=>setRecoveryOpen(false)}>닫기</Button></div><RecoveryKeyReveal store={store}/></section></div>:null;
  return <div className="notes-workspace" onBlur={e=>{if(e.target.matches(".notes-title,.memo-item-text,.memo-body-text"))void store.flush();}} onKeyDownCapture={e=>{if(e.key!=="Escape"||e.nativeEvent.isComposing||e.keyCode===229||(!selected&&!creatingSecret)||(e.target as HTMLElement).matches?.(".memo-rename")||document.querySelector('[data-state="open"], [role="dialog"]'))return;e.preventDefault();e.stopPropagation();close();}} onKeyDown={e=>{if(e.nativeEvent.isComposing||e.keyCode===229)return;const mod=e.ctrlKey||e.metaKey;const key=e.key.toLowerCase();
      const target=e.target as HTMLElement;
      const undoTarget=target.matches?.(".notes-title,.memo-item-text,.memo-body-text,.memo-rename")&&!target.closest(".notes-secret");
      if(mod&&undoTarget&&key==="z"&&!e.shiftKey){if(noteUndo.undo()){e.preventDefault();e.stopPropagation();}}
      else if(mod&&undoTarget&&((key==="z"&&e.shiftKey)||key==="y")){if(noteUndo.redo()){e.preventDefault();e.stopPropagation();}}
      if(mod&&!e.shiftKey&&key==="n"&&state.unlocked){e.preventDefault();newNote();}
      if(mod&&key==="s"){e.preventDefault();void store.sync();}
}}>
    <ViewToolbar sectionDrop={sectionDrop} title="메모" titleContent={notesSectionTitle} chrome={{search:state.unlocked?{scope:"메모",query,label:"메모 검색",placeholder:"제목, 본문, 라벨 검색",onApply:setQuery}:undefined,status:state.unlocked?<span className="notes-save-status" role="status" aria-description={state.lastSyncedAt?`마지막 동기화 ${displayDateTime(state.lastSyncedAt, new Date(), { withTime: true })}`:undefined}><BusyLabel busy={!editing && !state.error && !state.notes.some(n=>n.conflict) && (state.saving || state.syncing)} idle={status}>{state.saving ? "PC에 저장 중…" : "동기화 중…"}</BusyLabel></span>:undefined}}/>
    {state.error&&<div className="notes-error" role="alert"><span>{state.error}</span><Button size="sm" variant="ghost" disabled={state.syncing} onClick={()=>void (state.unlocked?store.sync():store.load())}>다시 시도</Button></div>}
    {main}
    {recoverySurface}
  </div>;
}
