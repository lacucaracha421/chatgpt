import { useCallback, useEffect, useMemo, useRef, useState, useSyncExternalStore, type CSSProperties, type MouseEvent } from "react";
import { ArrowPathIcon, DocumentTextIcon, ListBulletIcon, LockClosedIcon, WalletIcon } from "@heroicons/react/24/outline";
import { openUrl } from "@tauri-apps/plugin-opener";
import { useLibrary } from "../library/LibraryContext";
import { ViewToolbar } from "../layout/ViewToolbar";
import { Button } from "../shared/ui/Button";
import { Menu, type MenuItem } from "../shared/ui/Menu";
import { PlusIcon, BookmarkIcon, TrashIcon, EllipsisHorizontalIcon } from "../shared/ui/ArchiveIcons";
import { MarkdownView } from "../shared/markdown/MarkdownView";
import { MarkdownHelpButton } from "../shared/markdown/MarkdownHelp";
import { toggleMarkdownTask } from "../shared/markdown/markdown";
import { ChecklistEditor } from "./ChecklistEditor";
import { SecretEditor, SecretGate } from "./SecretNote";
import { byOrder, checklistMarkdown, labelKey, NOTE_COLORS, NOTE_LIMITS, noteColorValue, noteLimitProblem, normalizeLabel, stripMarkdown, textToItems, type NoteKind } from "./model";
import { isSecret, NOTES_REFRESH_INTERVAL, noteKind, notesStore, PIN_REQUIRED_TEXT, type Note, type NotesStore } from "./store";
import { genericView, isLedgerKind, LEDGER } from "./ledger/model";
import { hiddenLedgerMonths, LedgerView, ledgerPreview } from "./ledger/LedgerView";
import QRCode from "qrcode";
import "./notes.css";

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
  return <div className="notes-setup"><span className="notes-eyebrow">PRIVATE NOTES</span><h2>메모 암호화</h2><p>제목과 본문은 이 PC에서 암호화됩니다.<br/>다른 PC에서는 같은 복구키로 메모를 열 수 있습니다.</p>
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

/** Search: title, body, checklist items and labels in memory; secret and ledger notes by title only. */
export function noteMatches(note: Note, query: string) {
  if (!query) return true;
  const text = isSecret(note) || isLedgerKind(note) ? note.title : [note.title, note.body, ...(note.items ?? []).map((item) => item.text), ...(note.labels ?? [])].join("\n");
  return text.toLocaleLowerCase().includes(query.toLocaleLowerCase());
}
function preview(note: Note, notes: Note[]) {
  if (isSecret(note)) return "암호 메모";
  if (note.type === LEDGER && !note.readOnly && !note.deleted) return ledgerPreview(note, notes);
  if (noteKind(note) === "checklist" && !note.readOnly) {
    const items = [...(note.items ?? [])].sort(byOrder);
    const open = items.filter((item) => !item.checked).map((item) => item.text.trim()).filter(Boolean);
    return items.length ? `${items.length - open.length}/${items.length} · ${open.slice(0, 4).join(", ") || "모두 완료"}` : "빈 체크리스트";
  }
  return stripMarkdown(note.body) || "내용 없음";
}

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
  return <div className="notes-setup"><span className="notes-eyebrow">PRIVATE NOTES</span><h2>키링이 잠겨 있습니다</h2>
    <p>메모 암호화 키는 시스템 키링에 있습니다.<br />로그인 암호로 키링을 열면 메모를 볼 수 있습니다.</p>
    <div className="notes-setup-actions"><Button variant="primary" disabled={busy} onClick={() => void store.unlockKeyring()}>키링 잠금 해제</Button></div></div>;
}

export function NotesView(){const {library}=useLibrary();return library?<NotesWorkspace key={library.root} store={notesStore(library.root)}/>:null;}
export function NotesWorkspace({store}:{store:NotesStore}){
  const state=useSyncExternalStore(store.subscribe,store.snapshot);
  const [selected,setSelected]=useState<string|null>(null);const [query,setQuery]=useState("");const [scope,setScope]=useState<Scope>("all");const [label,setLabel]=useState<string|null>(null);
  const [editingBody,setEditingBody]=useState(false);const [creatingSecret,setCreatingSecret]=useState(false);const [keyringBusy,setKeyringBusy]=useState(false);
  const bodyRef=useRef<HTMLTextAreaElement>(null);const titleRef=useRef<HTMLInputElement>(null);
  const [editing,setEditing]=useState(false);
  const editTimer=useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  useEffect(()=>()=>clearTimeout(editTimer.current),[]);
  const [backupBusy,setBackupBusy]=useState(false);
  useEffect(()=>{void store.load();},[store]);
  useEffect(()=>{if(!state.unlocked)return;const refresh=()=>{if(!document.hidden)void store.sync(false);};refresh();window.addEventListener("focus",refresh);const timer=setInterval(refresh,NOTES_REFRESH_INTERVAL);return()=>{window.removeEventListener("focus",refresh);clearInterval(timer);};},[store,state.unlocked]);
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
    previous.current=selected;
    // Closing a secret note locks; moving straight to another secret note keeps the session.
    if(before&&isSecret(before)&&before.id!==selected&&!(now&&isSecret(now)))lockSecrets();
  },[selected,lockSecrets]);

  const allLabels=useMemo(()=>{const map=new Map<string,{label:string;count:number}>();for(const n of state.notes)if(!n.deleted)for(const l of n.labels??[]){const k=labelKey(l);const e=map.get(k);if(e)e.count++;else map.set(k,{label:l,count:1});}return [...map.values()].sort((a,b)=>a.label.localeCompare(b.label,"ko"));},[state.notes]);
  // Ledger month notes are internal to their ledger (design §4.1): never listed, searched or counted.
  const hiddenMonths=useMemo(()=>hiddenLedgerMonths(state.notes),[state.notes]);
  const notes=useMemo(()=>state.notes.filter(n=>!hiddenMonths.has(n.id)&&(scope==="trash"?n.deleted:!n.deleted&&(scope==="archive"?!!n.archived:!n.archived)&&(scope!=="pinned"||n.pinned))&&(!label||(n.labels??[]).some(l=>labelKey(l)===labelKey(label)))&&noteMatches(n,query)).sort((a,b)=>Number(b.pinned)-Number(a.pinned)||b.updatedAt.localeCompare(a.updatedAt)),[state.notes,hiddenMonths,query,scope,label]);
  const trash=scope==="trash";
  const found=state.notes.find(n=>n.id===selected && n.deleted===trash)??null;
  // A ledger opens its own screen; in trash, older schemas and orphan month notes it stays read-only.
  const ledgerOpen=!!found&&found.type===LEDGER&&!found.readOnly&&!trash;
  const note=ledgerOpen?found:genericView(found);
  const select=(id:string|null,editBody=false)=>{setCreatingSecret(false);setSelected(id);setEditingBody(editBody);setLimitError(null);};
  function newNote(kind:NoteKind="text"){
    if(kind==="secret"&&!revealed){setScope("all");setLabel(null);setQuery("");setSelected(null);setCreatingSecret(true);return;}
    setScope("all");setLabel(null);setQuery("");select(store.create(kind),true);
    requestAnimationFrame(()=>(kind==="text"?bodyRef.current:titleRef.current)?.focus());
  }
  /** Only one 가계부: opens the existing one, restores it from 휴지통 if that is the only one, or creates it pinned. */
  function openLedger(){
    const ledgers=state.notes.filter(n=>n.type===LEDGER).sort((a,b)=>a.createdAt.localeCompare(b.createdAt));
    const existing=ledgers.find(n=>!n.deleted)??ledgers.find(n=>n.deleted);
    if(existing?.deleted)store.edit({...existing,deleted:false});
    setScope("all");setLabel(null);setQuery("");select(existing?existing.id:store.create(LEDGER));
  }
  const [limitError,setLimitError]=useState<string|null>(null);
  function edit(change:Partial<Note>){if(note){const problem=noteLimitProblem({...note,...change});setLimitError(problem);if(problem)return;setEditing(true);clearTimeout(editTimer.current);editTimer.current=setTimeout(()=>setEditing(false),1200);store.edit({...note,...change});}}
  function convert(){
    if(!note||note.readOnly||note.redacted||isSecret(note)||isLedgerKind(note)||trash)return;
    if(noteKind(note)==="checklist")edit({type:"text",body:checklistMarkdown(note.items??[]),items:undefined});
    else edit({type:"checklist",items:textToItems(note.body)});
  }
  function startBodyEdit(event?:MouseEvent){
    if(event&&(event.target as HTMLElement).closest("a,button,input,label"))return;
    setEditingBody(true);requestAnimationFrame(()=>bodyRef.current?.focus());
  }
  async function backup(operation:"export"|"import"){setBackupBusy(true);try{await store.backup(operation);}finally{setBackupBusy(false);}}
  const settings=<div className="notes-backup"><Button disabled={backupBusy||state.syncing||state.saving} onClick={()=>void backup("export")}>암호화 백업 저장</Button><Button disabled={backupBusy||state.syncing||state.saving} onClick={()=>void backup("import")}>백업에서 메모 추가</Button><p>같은 복구키의 백업을 새 메모로 추가합니다. 기존 메모는 유지됩니다.</p><RecoveryKeyReveal store={store}/></div>;
  const status=state.error?"저장·동기화 확인 필요":state.notes.some(n=>n.conflict)?"충돌 확인 필요":editing?"편집 중":state.saving?"PC에 저장 중…":state.syncing?"동기화 중…":state.notes.some(n=>n.pending)?"PC에 저장됨 · 동기화 대기":state.lastSyncedAt?"동기화됨":"PC에 저장됨";
  const scopeButton=(value:Scope,text:string,count?:number)=><button className="workspace-index-link" aria-current={scope===value&&!label?"page":undefined} onClick={()=>{setScope(value);setLabel(null);}}>{text}{count!==undefined&&<span>{count}</span>}</button>;
  const navigation=<div className="notes-index"><div className="notes-scopes">{scopeButton("all","모든 메모",state.notes.filter(n=>!n.deleted&&!n.archived&&!hiddenMonths.has(n.id)).length)}{scopeButton("pinned","고정")}{scopeButton("archive","보관함")}{scopeButton("trash","휴지통")}
      {allLabels.length>0&&<div className="notes-label-index" aria-label="라벨"><span className="notes-label-index__title">라벨</span>{allLabels.map(l=><button key={labelKey(l.label)} className="workspace-index-link" aria-current={label&&labelKey(label)===labelKey(l.label)?"page":undefined} onClick={()=>{setLabel(l.label);if(scope==="trash"||scope==="pinned")setScope("all");}}>{l.label}<span>{l.count}</span></button>)}</div>}</div>
    <div className="notes-list" aria-label="메모 목록">{notes.map(n=><button key={n.id} className={`notes-list-item${selected===n.id?" is-selected":""}${noteColorValue(n.color)?" has-tint":""}`} style={tint(n.color)} onClick={()=>select(n.id)} aria-current={selected===n.id?"true":undefined}><span className="notes-list-title">{n.pinned&&<BookmarkIcon aria-label="고정됨"/>}{isSecret(n)&&<LockClosedIcon aria-label="암호 메모"/>}{n.type===LEDGER&&<WalletIcon aria-hidden="true"/>}{n.title.trim()||"제목 없는 메모"}{n.conflictCopy&&<span className="notes-copy-mark">사본</span>}{n.conflict&&<span className="notes-conflict-mark" aria-description="충돌 확인 필요">!</span>}</span><span className="notes-list-preview">{preview(n,state.notes)}</span><time dateTime={n.updatedAt}>{new Date(n.updatedAt).toLocaleDateString("ko-KR",{month:"short",day:"numeric"})}</time></button>)}{!!state.unreadable&&<p className="notes-list-empty" role="status">읽을 수 없는 메모 {state.unreadable}개는 목록에서 뺐습니다.</p>}{state.unlocked&&!notes.length&&<p className="notes-list-empty">{query?"검색 결과가 없습니다":trash?"휴지통이 비어 있습니다":scope==="archive"?"보관한 메모가 없습니다":"메모가 없습니다"}</p>}</div>
  </div>;
  const newItems:MenuItem[]=[{id:"text",label:"메모",onSelect:()=>newNote("text")},{id:"checklist",label:"체크리스트",onSelect:()=>newNote("checklist")},{id:"secret",label:"암호 메모",onSelect:()=>newNote("secret")},{id:"ledger",label:"가계부",onSelect:openLedger}];
  const kind=note?noteKind(note):"text";
  const editable=!!note&&!trash&&!note.readOnly&&!note.redacted;
  const colorItems:MenuItem[]=note?[{id:"none",label:"기본",group:"color",selected:!noteColorValue(note.color),onSelect:()=>edit({color:null})},...NOTE_COLORS.map(c=>({id:c.key,label:c.label,group:"color",selected:note.color===c.key,icon:<span className="notes-swatch" style={{background:c.value}} aria-hidden="true"/>,onSelect:()=>edit({color:c.key})}))]:[];
  // Archive sits in the ⋯ menu next to 휴지통, away from the everyday actions.
  const moreItems:MenuItem[]=note&&!trash?[{id:"archive",label:note.archived?"보관 해제":"보관함으로 보내기",onSelect:()=>edit({archived:!note.archived})}]:[];
  const canConvert=!!note&&editable&&!isSecret(note);
  const convertLabel=kind==="checklist"?"메모로 바꾸기":"체크리스트로 바꾸기";
  const colorValue=note?noteColorValue(note.color):null;
  const syncTitle=state.error?`동기화 확인 필요: ${state.error}`:state.syncing?"동기화 중…":state.lastSyncedAt?`동기화 · 마지막 ${new Date(state.lastSyncedAt).toLocaleString("ko-KR")}`:"동기화";
  const body=!note?null:isSecret(note)&&state.secretLocked&&!note.redacted?<SecretGate key={`resume-${note.id}`} store={store} onOpened={()=>store.resumeSecretSaves()}/>
    :isSecret(note)?(note.redacted?<SecretGate key={note.id} store={store} onOpened={()=>void store.refresh()}/>
      :<SecretEditor fields={note.fields??[]} memo={note.memo??""} readOnly={!editable} onChange={change=>edit(change)}/>)
    :kind==="checklist"&&!note.readOnly?<ChecklistEditor items={note.items??[]} readOnly={!editable} onChange={items=>edit({items})}/>
    :note.readOnly||(!trash&&!editingBody)?<div className="notes-rendered" onClick={note.readOnly?undefined:startBodyEdit}>{note.body.trim()?<MarkdownView source={note.body} onOpenLink={href=>void openUrl(href)} onToggleTask={note.readOnly?undefined:(line,checked)=>edit({body:toggleMarkdownTask(note.body,line,checked)})}/>:<p className="notes-rendered__empty">여기에 적어보세요…</p>}</div>
    :<textarea ref={bodyRef} className="notes-body" aria-label="메모 본문" placeholder="여기에 적어보세요…" value={note.body} readOnly={trash} spellCheck={false} onChange={e=>edit({body:e.target.value})}
        // Leaving the text for the rest of the note (or a blank spot, or Esc) returns to the
        // rendered view. Focus moving outside the editor (menus handing focus back to the
        // toolbar, another window) keeps editing.
        onBlur={e=>{if(trash)return;const next=e.relatedTarget as Node|null;if(next?e.currentTarget.closest(".notes-editor")?.contains(next):document.hasFocus())setEditingBody(false);}}
        onKeyDown={e=>{if(e.key==="Escape"&&!trash&&!e.nativeEvent.isComposing){e.preventDefault();e.stopPropagation();setEditingBody(false);}}}/>;
  const footer=!note?null:isSecret(note)?"암호 메모 · 이 PC의 PIN으로 잠김":kind==="checklist"&&!note.readOnly?`${(note.items??[]).filter(i=>i.checked).length}/${(note.items??[]).length} 완료`:`${note.body.length.toLocaleString()}자`;
  const main=!state.ready?<div className="notes-empty">메모를 불러오는 중…</div>
    :state.keyringLocked?<KeyringLocked store={store} busy={keyringBusy}/>
    :!state.unlocked?<KeySetup store={store}/>
    :creatingSecret?<SecretGate store={store} onOpened={()=>{setCreatingSecret(false);select(store.create("secret"),true);requestAnimationFrame(()=>titleRef.current?.focus());}} onCancel={()=>setCreatingSecret(false)}/>
    :ledgerOpen&&note?<LedgerView key={note.id} store={store} ledgerId={note.id} actions={<>
        <Button size="icon" variant="ghost" aria-label={note.pinned?"고정 해제":"메모 고정"} aria-pressed={note.pinned} onClick={()=>edit({pinned:!note.pinned})}><BookmarkIcon/></Button>
        <Menu label="메모 더보기" items={moreItems} trigger={<EllipsisHorizontalIcon aria-hidden="true"/>} triggerClassName="notes-menu-trigger"/>
        <Button size="icon" variant="ghost" aria-label="메모를 휴지통으로" onClick={()=>{edit({deleted:true});select(null);}}><TrashIcon/></Button></>}>
        {note.conflict&&<div className="notes-conflict ledger-banner" role="status"><p>다른 기기에서도 수정됐습니다. 이 메모를 복사본으로 남기고 서버 버전을 불러올 수 있습니다.</p><Button size="sm" disabled={state.syncing||state.saving} onClick={()=>void store.resolve(note,true)}>내 내용 보관 후 서버 버전 불러오기</Button></div>}
        {limitError&&<p className="notes-limit ledger-banner" role="alert">{limitError}</p>}
      </LedgerView>
    :!note?<div className="notes-empty"><span className="notes-eyebrow">NOTES</span><h2>{trash?"휴지통":scope==="archive"?"보관함":"메모"}</h2><p>{notes.length?"왼쪽에서 메모를 선택하세요.":query?"검색 결과가 없습니다.":trash?"삭제한 메모가 없습니다.":scope==="archive"?"보관한 메모가 없습니다.":"아직 작성한 메모가 없습니다."}</p>{!trash&&<Button variant="ghost" onClick={()=>newNote()}>＋ 새 메모</Button>}</div>
    :<article className={`notes-editor${noteColorValue(note.color)?" has-tint":""}`} style={tint(note.color)}>
      <div className="notes-editor-actions"><time dateTime={note.updatedAt}>{new Date(note.updatedAt).toLocaleString("ko-KR",{dateStyle:"medium",timeStyle:"short"})}</time><div>
        {canConvert&&<Button size="icon" variant="ghost" aria-label={convertLabel} title={`${convertLabel} (Ctrl+Shift+L)`} onClick={convert}>{kind==="checklist"?<DocumentTextIcon/>:<ListBulletIcon/>}</Button>}
        {!trash&&kind==="text"&&!note.readOnly&&<MarkdownHelpButton/>}
        {!trash&&isSecret(note)&&!note.redacted&&<Button size="icon" variant="ghost" aria-label="지금 잠그기" onClick={lockSecrets}><LockClosedIcon/></Button>}
        {!trash&&<Button size="icon" variant="ghost" aria-label={note.pinned?"고정 해제":"메모 고정"} aria-pressed={note.pinned} onClick={()=>edit({pinned:!note.pinned})}><BookmarkIcon/></Button>}
        {!trash&&<Menu label="메모 색상" items={colorItems} trigger={<span className={`notes-color-dot${colorValue?"":" is-empty"}`} style={colorValue?{background:colorValue}:undefined} aria-hidden="true"/>} triggerClassName="notes-menu-trigger"/>}
        <span className="notes-editor-actions__gap" aria-hidden="true"/>
        {moreItems.length>0&&<Menu label="메모 더보기" items={moreItems} trigger={<EllipsisHorizontalIcon aria-hidden="true"/>} triggerClassName="notes-menu-trigger"/>}
        {trash?<Button size="sm" onClick={()=>{edit({deleted:false});setScope("all");}}>복원</Button>:<Button size="icon" variant="ghost" aria-label="메모를 휴지통으로" onClick={()=>{edit({deleted:true});select(null);}}><TrashIcon/></Button>}
      </div></div>
      {note.conflict&&<div className="notes-conflict" role="status"><p>다른 기기에서도 수정됐습니다. 이 메모를 복사본으로 남기고 서버 버전을 불러올 수 있습니다.</p><Button size="sm" disabled={state.syncing||state.saving} onClick={()=>void store.resolve(note,true)}>내 내용 보관 후 서버 버전 불러오기</Button></div>}
      {note.conflictCopy&&<div className="notes-conflict" role="status"><p>다른 기기의 수정과 겹쳐 두 내용을 모두 보관했습니다. 이 메모는 이 PC에서 쓴 내용입니다.</p><Button size="sm" variant="ghost" onClick={()=>void store.dismissConflictCopy(note.id)}>확인</Button></div>}
      {limitError&&<p className="notes-limit" role="alert">{limitError}</p>}
      {isSecret(note)&&state.secretLocked&&!note.redacted&&<p className="notes-readonly" role="status">잠금이 풀린 사이 저장하지 못한 변경이 있습니다. PIN을 입력하면 이어서 저장합니다.</p>}
      {note.readOnly&&<p className="notes-readonly" role="status">새 버전의 앱에서 만든 메모입니다. 앱을 업데이트하면 편집할 수 있습니다.</p>}
      <input ref={titleRef} className="notes-title" aria-label="메모 제목" placeholder={isSecret(note)?"암호 메모 제목":"제목 없는 메모"} maxLength={NOTE_LIMITS.title} value={note.title} readOnly={trash||!!note.readOnly} onChange={e=>edit({title:e.target.value})}/>
      {!note.redacted&&(editable||(note.labels??[]).length>0)&&<LabelEditor key={note.id} labels={note.labels??[]} suggestions={allLabels.map(l=>l.label)} onChange={labels=>editable&&edit({labels})}/>}
      {body}
      <footer className="notes-editor-footer"><span>{footer}</span>
        <Button size="icon" variant="ghost" className={`notes-sync${state.syncing?" is-syncing":""}${state.error?" is-error":""}`} aria-label="동기화" aria-busy={state.syncing} title={syncTitle} disabled={state.syncing||state.saving} onClick={()=>void store.sync()}><ArrowPathIcon aria-hidden="true"/></Button></footer>
    </article>;
  return <div className="notes-workspace" onKeyDown={e=>{if(e.nativeEvent.isComposing)return;const mod=e.ctrlKey||e.metaKey;const key=e.key.toLowerCase();
      if(mod&&!e.shiftKey&&key==="n"&&state.unlocked){e.preventDefault();newNote();}
      if(mod&&key==="s"){e.preventDefault();void store.sync();}
      if(mod&&!e.shiftKey&&key==="e"&&note&&kind==="text"&&!note.readOnly&&!trash){e.preventDefault();editingBody?setEditingBody(false):startBodyEdit();}
      if(mod&&e.shiftKey&&key==="l"){e.preventDefault();convert();}}}>
    <ViewToolbar title="메모" chrome={{navigation:state.unlocked?navigation:<p className="notes-list-empty">암호화된 개인 메모</p>,search:state.unlocked?{scope:"메모",query,label:"메모 검색",placeholder:"제목, 본문, 라벨 검색",onApply:setQuery}:undefined,actions:state.unlocked?<Menu label="새 메모" items={newItems} trigger={<PlusIcon aria-hidden="true"/>} triggerClassName="notes-menu-trigger"/>:undefined,settings:state.unlocked?settings:undefined,summary:"메모 백업과 복원",status:state.unlocked?<span className="notes-save-status" role="status" aria-description={state.lastSyncedAt?`마지막 동기화 ${new Date(state.lastSyncedAt).toLocaleString()}`:undefined}>{status}</span>:undefined}}/>
    {state.error&&<div className="notes-error" role="alert"><span>{state.error}</span><Button size="sm" variant="ghost" disabled={state.syncing} onClick={()=>void (state.unlocked?store.sync():store.load())}>다시 시도</Button></div>}
    {main}
  </div>;
}
