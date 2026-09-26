import {useVisibleInterval} from './useVisibleInterval';
import {SIGNAL_FALLBACK_MS,useSyncSignal} from './syncSignals';
import {TopBar} from './TopBar';
import {useCallback,useEffect,useLayoutEffect,useMemo,useRef,useState,useSyncExternalStore,type CSSProperties,type MouseEvent,type MutableRefObject} from 'react';
import {ArchiveBoxIcon,ArrowLeftIcon,ArrowPathIcon,DocumentTextIcon,EllipsisHorizontalIcon,KeyIcon,ListBulletIcon,LockClosedIcon,MagnifyingGlassIcon,PlusIcon,TrashIcon,WalletIcon,XMarkIcon} from '@heroicons/react/24/outline';
import {PinIcon} from './PinIcon';
import {Button,IconButton} from './ui';
import {BottomSheet} from './BottomSheet';
import {usePullToRefresh} from './usePullToRefresh';
import {native,errorText} from './transport';
import {useLevelMotion} from './motion';
import {MarkdownView} from '../src/shared/markdown/MarkdownView';
import {toggleMarkdownTask} from '../src/shared/markdown/markdown';
import {MarkdownHelpButton} from './MarkdownHelp';
import {byOrder,checklistMarkdown,labelKey,NOTE_COLORS,NOTE_LIMITS,noteColorValue,noteLimitProblem,normalizeLabel,stripMarkdown,textToItems,type NoteKind} from '../src/notes/model';
import {isSecret,noteKind,NotesStore,PIN_REQUIRED_TEXT,type Note} from '../src/notes/store';
import {genericView,isLedgerKind,LEDGER,LEDGER_MONTH} from '../src/notes/ledger/model';
import {LedgerCard,NoteLedger} from './NoteLedger';
import {NoteChecklist} from './NoteChecklist';
import {copySecret,SecretEditor,SecretGate} from './NoteSecret';
import {revealCaret} from './noteCaret';
import './notes.css';

/** A decrypted note as native returns it (Notes v2 fields are optional: v1 notes lack them). */
export type MobileNote=Note;
/** Secret notes lock again after this much inactivity (native enforces the same). */
export const SECRET_IDLE_MS=5*60_000;
const SECRET_TOUCH_MS=60_000;

/**
 * The PC notes store drives the tablet too (same queue, rebase, keep-both and secret-lock
 * semantics); only its transport differs. Native errors reach it as their Korean text, which
 * is what the store shows and matches (the PIN prompt texts).
 */
const OPERATIONS:Record<string,string>={state:'notesState',unlock:'notesUnlock',save:'notesSave',sync:'notesSync',secretStatus:'notesSecretStatus',secretSetPin:'notesSecretSetPin',secretUnlock:'notesSecretUnlock',secretResetPin:'notesSecretResetPin',secretLock:'notesSecretLock',secretTouch:'notesSecretTouch',dismissConflictCopy:'notesDismissConflictCopy',recoveryKey:'notesRecoveryKey',ledgerMonthId:'notesLedgerMonthId'};
export function mobileNotesRequest<T>(operation:string,input:unknown={}):Promise<T> {
  const op=OPERATIONS[operation];
  if(!op)return Promise.reject('이 기기에서는 지원하지 않는 메모 작업입니다.');
  return native<T>(op,input as Record<string,unknown>).catch((reason:unknown)=>{throw errorText(reason)||'메모 작업을 완료하지 못했습니다. 작성 내용은 유지됩니다.';});
}

type Scope='all'|'archive'|'trash';
type Sheet='new'|'color'|'more'|'list'|'recovery'|null;
const tint=(color:string|null|undefined)=>{const value=noteColorValue(color);return value?({'--note-tint':value} as CSSProperties):undefined;};
/** Search: title, body, checklist items and labels in memory; secret notes by title only. */
export function noteMatches(note:Note,query:string) {
  if(!query)return true;
  // A ledger matches by title only; its entries are searched inside the ledger.
  const text=isSecret(note)||isLedgerKind(note)?note.title:[note.title,note.body,...(note.items??[]).map(item=>item.text),...(note.labels??[])].join('\n');
  return text.toLocaleLowerCase().includes(query.toLocaleLowerCase());
}
function preview(note:Note) {
  if(isSecret(note))return '암호 메모';
  if(noteKind(note)==='checklist'&&!note.readOnly){
    const items=[...(note.items??[])].sort(byOrder);const open=items.filter(item=>!item.checked).map(item=>item.text.trim()).filter(Boolean);
    return items.length?`${items.length-open.length}/${items.length} · ${open.slice(0,4).join(', ')||'모두 완료'}`:'빈 체크리스트';
  }
  return stripMarkdown(note.body);
}

function LabelEditor({labels,suggestions,readOnly,onChange}:{labels:string[];suggestions:string[];readOnly:boolean;onChange(labels:string[]):void}) {
  const [adding,setAdding]=useState(false),[text,setText]=useState('');
  function commit(close:boolean){
    const label=normalizeLabel(text);
    if(label&&labels.length<NOTE_LIMITS.labels&&!labels.some(entry=>labelKey(entry)===labelKey(label)))onChange([...labels,label]);
    setText('');if(close)setAdding(false);
  }
  return <div className="notes-labels" aria-label="라벨">
    {labels.map(label=><span key={label} className="notes-label-chip">{label}{!readOnly&&<button type="button" aria-label={`${label} 라벨 빼기`} onClick={()=>onChange(labels.filter(entry=>entry!==label))}><XMarkIcon aria-hidden="true"/></button>}</span>)}
    {!readOnly&&(adding?<>
      <input className="notes-label-input" aria-label="라벨 추가" list="notes-label-options" autoFocus maxLength={NOTE_LIMITS.labelChars} value={text} enterKeyHint="done"
        onChange={event=>setText(event.target.value)} onBlur={()=>commit(true)} onKeyDown={event=>{if(event.nativeEvent.isComposing||event.keyCode===229)return;if(event.key==='Enter'){event.preventDefault();commit(false);}}}/>
      <datalist id="notes-label-options">{suggestions.filter(entry=>!labels.some(label=>labelKey(label)===labelKey(entry))).map(entry=><option key={entry} value={entry}/>)}</datalist>
    </>:labels.length<NOTE_LIMITS.labels&&<button type="button" className="notes-label-add" onClick={()=>setAdding(true)}><PlusIcon aria-hidden="true"/>라벨</button>)}
  </div>;
}

/** Shows the recovery key (to register another PC); with a PIN set it needs the PIN first. */
function RecoveryKey({store}:{store:NotesStore}) {
  const [key,setKey]=useState<string|null>(null),[needPin,setNeedPin]=useState(false),[pin,setPin]=useState(''),[error,setError]=useState(''),[copied,setCopied]=useState(false);
  async function reveal(){setError('');try{setKey((await store.request<{key:string}>('recoveryKey')).key);setNeedPin(false);}catch(e){if(e===PIN_REQUIRED_TEXT)setNeedPin(true);else setError(typeof e==='string'?e:'복구키를 불러오지 못했습니다.');}}
  async function unlockAndReveal(){setError('');const failure=await store.openSecrets('secretUnlock',{pin});setPin('');if(failure)setError(failure);else await reveal();}
  useEffect(()=>{void reveal();},[]);
  return <div className="notes-recovery">
    {key!==null?<>
      <textarea className="notes-recovery__key" aria-label="복구키" value={key} readOnly spellCheck={false}/>
      <p className="hint">다른 사람이 보지 않는 곳에서 열고, 따로 보관해 주세요. 복사한 키는 30초 뒤 클립보드에서 지웁니다.</p>
      <Button onClick={()=>void copySecret(key).then(()=>setCopied(true),()=>setError('복사하지 못했습니다.'))}>{copied?'복사했습니다':'복구키 복사'}</Button>
    </>:needPin?<form onSubmit={event=>{event.preventDefault();void unlockAndReveal();}}>
      <label>암호 메모 PIN<input className="notes-secret-gate__pin" type="password" inputMode="numeric" autoComplete="off" maxLength={8} value={pin} onChange={event=>setPin(event.target.value.replace(/\D/g,''))}/></label>
      <p className="hint">복구키로 PIN을 바꿀 수 있어서, 보려면 이 태블릿의 PIN이 필요합니다.</p>
      <Button type="submit" variant="primary" disabled={pin.length<4}>확인 후 복구키 보기</Button>
    </form>:!error&&<p className="hint">불러오는 중…</p>}
    {error&&<p role="alert" className="notes-secret-gate__error">{error}</p>}
  </div>;
}

export function Notes({active,backRef}:{active:boolean;backRef:MutableRefObject<(()=>boolean)|null>}) {
  const [store]=useState(()=>new NotesStore(mobileNotesRequest));
  const state=useSyncExternalStore(store.subscribe,store.snapshot);
  const [key,setKey]=useState('');
  const [selected,setSelected]=useState<string|null>(null),[scope,setScope]=useState<Scope>('all'),[label,setLabel]=useState<string|null>(null),[query,setQuery]=useState('');
  const [editingBody,setEditingBody]=useState(false),[creatingSecret,setCreatingSecret]=useState(false),[sheet,setSheet]=useState<Sheet>(null),[limitError,setLimitError]=useState<string|null>(null);
  const bodyRef=useRef<HTMLTextAreaElement>(null),titleRef=useRef<HTMLInputElement>(null),pane=useRef<HTMLDivElement>(null);
  useEffect(()=>{void store.load();},[store]);
  const trash=scope==='trash';
  const found=state.notes.find(n=>n.id===selected)??null;
  // A live ledger opens its own screens; a trashed one and a month note whose ledger is gone
  // stay read-only with their text fallback (pin, trash, archive and restore still work).
  const ledgerOpen=!!found&&found.type===LEDGER&&!found.deleted&&!found.readOnly;
  const note=ledgerOpen?found:genericView(found);
  const ledgerBack=useRef<(()=>boolean)|null>(null);
  // Month notes live inside their ledger: out of the list, 보관함, labels and counts.
  const ledgerIds=useMemo(()=>new Set(state.notes.filter(n=>n.type===LEDGER).map(n=>n.id)),[state.notes]);
  const listed=useMemo(()=>state.notes.filter(n=>!(n.type===LEDGER_MONTH&&!!n.ledger&&ledgerIds.has(n.ledger))),[state.notes,ledgerIds]);
  // ---- Sync: at once when Notes opens, every minute (or when `signals.notes` moves while the
  // status long-poll is live, with a 10 min fallback), and backing off while writes wait.
  const pending=state.notes.some(n=>n.pending);
  const [retryDelay,setRetryDelay]=useState(2000);
  useEffect(()=>{setRetryDelay(2000);},[pending]);
  const notesSignalled=useSyncSignal('notes',()=>void store.sync(),active&&state.unlocked&&!pending);
  useVisibleInterval(()=>void store.sync(),active&&state.unlocked&&!pending?(notesSignalled?SIGNAL_FALLBACK_MS:60_000):null,true);
  useVisibleInterval(()=>{void store.sync().finally(()=>setRetryDelay(delay=>Math.min(60_000,delay*2)));},active&&state.unlocked&&pending?retryDelay:null);
  useEffect(()=>{const leave=()=>{if(document.visibilityState==='hidden')void store.flush();};document.addEventListener('visibilitychange',leave);return()=>document.removeEventListener('visibilitychange',leave);},[store]);
  // ---- Secret notes lock after 5 idle minutes, when the app goes to the background (native
  // locks in onStop and tells the page), when Notes is left, and when the note is closed.
  const revealed=state.notes.some(n=>isSecret(n)&&!n.redacted);
  const lockSecrets=useCallback(()=>{void store.lockSecrets();},[store]);
  useEffect(()=>{
    if(!revealed)return;
    let timer=setTimeout(lockSecrets,SECRET_IDLE_MS),touched=Date.now();
    const bump=()=>{clearTimeout(timer);timer=setTimeout(lockSecrets,SECRET_IDLE_MS);if(Date.now()-touched>=SECRET_TOUCH_MS){touched=Date.now();void store.touchSecrets();}};
    window.addEventListener('pointerdown',bump);window.addEventListener('keydown',bump);
    return()=>{clearTimeout(timer);window.removeEventListener('pointerdown',bump);window.removeEventListener('keydown',bump);};
  },[revealed,lockSecrets,store]);
  useEffect(()=>{window.addEventListener('lakomics-notes-locked',lockSecrets);return()=>window.removeEventListener('lakomics-notes-locked',lockSecrets);},[lockSecrets]);
  useEffect(()=>{if(!active&&revealed)lockSecrets();},[active,revealed,lockSecrets]);
  useEffect(()=>()=>{void store.lockSecrets();},[store]);
  const notesRef=useRef(state.notes);notesRef.current=state.notes;
  const previous=useRef<string|null>(null);
  useEffect(()=>{
    const before=notesRef.current.find(n=>n.id===previous.current),now=notesRef.current.find(n=>n.id===selected);
    previous.current=selected;
    // Moving straight to another secret note keeps the session.
    if(before&&isSecret(before)&&before.id!==selected&&!(now&&isSecret(now)))lockSecrets();
  },[selected,lockSecrets]);
  useEffect(()=>{if(!state.moved)return;if(selected===state.moved.from)setSelected(state.moved.to);store.clearMoved();},[state.moved,selected,store]);
  // ---- Navigation
  const select=(id:string|null,editBody=false)=>{setCreatingSecret(false);setSelected(id);setEditingBody(editBody);setLimitError(null);};
  const leave=()=>{select(null);void store.flush();};
  const kind=note?noteKind(note):'text';
  const editable=!!note&&!note.deleted&&!note.readOnly&&!note.redacted;
  const stopBodyEdit=()=>{setEditingBody(false);bodyRef.current?.blur();};
  useEffect(()=>{backRef.current=()=>{
    if(sheet){setSheet(null);return true;}
    if(ledgerOpen&&ledgerBack.current?.())return true;
    if(editingBody&&note&&!note.deleted){stopBodyEdit();return true;}
    if(creatingSecret){setCreatingSecret(false);return true;}
    if(selected){leave();return true;}
    if(scope!=='all'){setScope('all');return true;}
    if(label){setLabel(null);return true;}
    return false;
  };return()=>{backRef.current=null;};});
  function newNote(kind:NoteKind){
    setSheet(null);setScope('all');setLabel(null);setQuery('');
    if(kind==='secret'&&!revealed){setSelected(null);setCreatingSecret(true);return;}
    select(store.create(kind),kind==='text');
    requestAnimationFrame(()=>(kind==='text'?bodyRef.current:titleRef.current)?.focus());
  }
  /** One 가계부: opens the existing ledger, restores it from the trash, or creates it (pinned). */
  function openLedger(){
    setSheet(null);setScope('all');setLabel(null);setQuery('');
    const ledgers=state.notes.filter(n=>n.type===LEDGER&&!n.readOnly).sort((a,b)=>a.createdAt.localeCompare(b.createdAt));
    const existing=ledgers.find(n=>!n.deleted),trashed=ledgers.find(n=>n.deleted);
    if(!existing&&trashed)store.edit({...trashed,deleted:false});
    select(existing?existing.id:trashed?trashed.id:store.create(LEDGER));
  }
  function edit(change:Partial<Note>){if(!note)return;const problem=noteLimitProblem({...note,...change});setLimitError(problem);if(problem)return;store.edit({...note,...change});}
  const canConvert=!!note&&editable&&!isSecret(note);
  function convert(){
    if(!note||!canConvert)return;
    if(kind==='checklist')edit({type:'text',body:checklistMarkdown(note.items??[]),items:undefined});
    else{setEditingBody(false);edit({type:'checklist',items:textToItems(note.body)});}
  }
  function startBodyEdit(event?:MouseEvent){
    if(event&&(event.target as HTMLElement).closest('a,button,input,label'))return;
    setEditingBody(true);requestAnimationFrame(()=>bodyRef.current?.focus());
  }
  // ---- Keyboard: fit the editor to the visible area above the keyboard and keep the caret in view.
  const section=useRef<HTMLElement>(null);
  const [editorHeight,setEditorHeight]=useState<number>();
  const editingRef=useRef(editingBody);editingRef.current=editingBody;
  useLayoutEffect(()=>{
    const viewport=window.visualViewport;
    if(!active||!selected||!viewport){setEditorHeight(undefined);return;}
    let lastHeight=viewport.height;
    const update=()=>{
      // Limit the editor to the visible bottom, rather than subtracting the IME
      // twice when Android has already resized the WebView or applied insets.
      const top=section.current?.getBoundingClientRect().top??0;
      setEditorHeight(viewport.scale===1?Math.max(0,viewport.offsetTop+viewport.height-top):undefined);
      // The keyboard closed (Back hides it before any page Back): leave the source view.
      if(viewport.height-lastHeight>150&&editingRef.current&&document.activeElement===bodyRef.current){setEditingBody(false);bodyRef.current?.blur();}
      lastHeight=viewport.height;
      requestAnimationFrame(()=>revealCaret(pane.current));
    };
    update();
    viewport.addEventListener('resize',update);
    viewport.addEventListener('scroll',update);
    window.addEventListener('resize',update);
    return()=>{viewport.removeEventListener('resize',update);viewport.removeEventListener('scroll',update);window.removeEventListener('resize',update);};
  },[active,selected]);
  // The source text grows with its content inside the scrolling editor, so the caret is
  // revealed by scrolling the editor rather than hidden inside a fixed-height box.
  useLayoutEffect(()=>{const area=bodyRef.current;if(!area)return;area.style.height='auto';area.style.height=`${area.scrollHeight}px`;revealCaret(pane.current);},[note?.body,editingBody,selected]);
  const editing=!!(selected&&note)||creatingSecret;
  useLevelMotion(section,active&&state.ready&&state.unlocked?(editing?'edit':scope!=='all'?scope:'list'):null,(editing?1:0)+(scope!=='all'?1:0));
  // ---- List
  const allLabels=useMemo(()=>{const map=new Map<string,{label:string;count:number}>();for(const n of listed)if(!n.deleted)for(const l of n.labels??[]){const k=labelKey(l);const e=map.get(k);if(e)e.count++;else map.set(k,{label:l,count:1});}return [...map.values()].sort((a,b)=>a.label.localeCompare(b.label,'ko'));},[listed]);
  const visible=listed.filter(n=>(trash?n.deleted:!n.deleted&&(scope==='archive'?!!n.archived:!n.archived))&&(trash||!label||(n.labels??[]).some(l=>labelKey(l)===labelKey(label)))&&noteMatches(n,trash?'':query)).sort((a,b)=>Number(b.pinned)-Number(a.pinned)||b.updatedAt.localeCompare(a.updatedAt));
  const pinned=scope!=='all'?[]:visible.filter(n=>n.pinned),recent=scope!=='all'?visible:visible.filter(n=>!n.pinned);
  const trashed=listed.filter(n=>n.deleted).length,archived=listed.filter(n=>!n.deleted&&n.archived).length;
  const status=state.error?'확인 필요':state.saving?'저장 중':state.syncing?'동기화 중':pending?'동기화 대기':'동기화됨';
  const list=useRef<HTMLDivElement>(null);
  const pull=usePullToRefresh(list,()=>void store.sync(),state.syncing,!active||!state.unlocked||editing);
  const meta=(n:Note)=><>{n.conflictCopy&&<><b>사본</b> · </>}{relativeTime(n.updatedAt)}{n.pending&&<> · <i aria-hidden="true"/>동기화 대기</>}</>;
  const card=(n:Note)=>n.type===LEDGER&&!n.readOnly&&!n.deleted?<LedgerCard key={n.id} ledger={n} notes={state.notes} onOpen={()=>select(n.id)} meta={meta(n)}/>:<button key={n.id} className={`note-card${noteColorValue(n.color)?' has-tint':''}`} style={tint(n.color)} onClick={()=>select(n.id)}>
    <strong className={n.title.trim()?undefined:'is-untitled'}>{isSecret(n)&&<LockClosedIcon aria-label="암호 메모"/>}{n.title.trim()||'제목 없음'}</strong>
    {preview(n)&&<span>{preview(n).slice(0,240)}</span>}
    {!isSecret(n)&&!!n.labels?.length&&<em className="note-card__labels">{n.labels.map(l=><i key={l}>{l}</i>)}</em>}
    <small>{meta(n)}</small>
  </button>;
  const syncButton=<Button type="button" size="icon" variant="ghost" className={`notes-sync${state.syncing?' is-syncing':''}${state.error?' is-error':''}`} aria-label="동기화" aria-busy={state.syncing} disabled={state.syncing} onClick={()=>void store.sync()}><ArrowPathIcon aria-hidden="true"/></Button>;
  // ---- Editor body
  const colorValue=note?noteColorValue(note.color):null;
  const body=!note?null:isSecret(note)&&state.secretLocked&&!note.redacted?<SecretGate key={`resume-${note.id}`} store={store} onOpened={()=>store.resumeSecretSaves()}/>
    :isSecret(note)?(note.redacted?<SecretGate key={note.id} store={store} onOpened={()=>void store.refresh()}/>
      :<SecretEditor fields={note.fields??[]} memo={note.memo??''} readOnly={!editable} onChange={change=>edit(change)}/>)
    :kind==='checklist'&&!note.readOnly?<NoteChecklist items={note.items??[]} readOnly={!editable} onChange={items=>edit({items})}/>
    :note.readOnly||note.deleted||!editingBody?<div className="notes-rendered" onClick={note.readOnly||note.deleted?undefined:startBodyEdit}>{note.body.trim()?<MarkdownView source={note.body} onOpenLink={href=>void native('openExternal',{url:href}).catch(()=>{})} onToggleTask={note.readOnly||note.deleted?undefined:(line,checked)=>edit({body:toggleMarkdownTask(note.body,line,checked)})}/>:<p className="notes-rendered__empty">{note.deleted?'내용 없음':'여기에 메모하세요.'}</p>}</div>
    :<textarea ref={bodyRef} className="notes-body" aria-label="메모 내용" placeholder="여기에 메모하세요." value={note.body} spellCheck={false} onChange={event=>edit({body:event.target.value})} onInput={()=>revealCaret(pane.current)}
        // Leaving the text for the rest of the note (or a blank spot) returns to the rendered view;
        // focus moving to the header (help, colour) keeps editing.
        onBlur={event=>{const next=event.relatedTarget as Node|null;if(next?pane.current?.contains(next):document.hasFocus())setEditingBody(false);}}/>;
  return <section ref={section} className={`mobile-notes ${editing?'note-open':''}`} style={{display:active?undefined:'none',maxHeight:selected&&note?editorHeight:undefined}} aria-label="메모">
    {!state.ready?<TopBar title="메모" loading="메모 불러오는 중"/>:!state.unlocked?<>
      <TopBar title="메모"/>
      <form className="notes-unlock" onSubmit={event=>{event.preventDefault();void store.unlock(key).then(ok=>{if(ok)setKey('');});}}><h2>메모 연결</h2><p>PC 메모에서 사용하는 복구 키를 한 번 입력하세요.</p><input type="password" aria-label="메모 복구 키" value={key} autoComplete="off" spellCheck={false} autoCapitalize="none" onChange={event=>setKey(event.target.value)}/><Button type="submit" variant="primary" disabled={key.trim().length!==64}>메모 열기</Button></form>
    </>:null}
    {state.ready&&state.unlocked&&creatingSecret&&!note&&<>
      <header className="notes-top is-sub"><IconButton label="메모 목록" icon={ArrowLeftIcon} onClick={()=>setCreatingSecret(false)}/></header>
      <div className="notes-editor"><SecretGate store={store} onOpened={()=>{setCreatingSecret(false);select(store.create('secret'));requestAnimationFrame(()=>titleRef.current?.focus());}} onCancel={()=>setCreatingSecret(false)}/></div>
    </>}
    {state.ready&&state.unlocked&&note&&ledgerOpen&&<NoteLedger store={store} ledger={note} notes={state.notes} backRef={ledgerBack} onLeave={leave} onMore={()=>setSheet('more')}
      saveState={state.saving?'저장 중':state.notes.some(n=>n.pending&&(n.id===note.id||n.ledger===note.id))?'저장됨':'동기화됨'}/>}
    {state.ready&&state.unlocked&&note&&!ledgerOpen&&<>
      <header className="notes-top is-sub"><IconButton label="메모 목록" icon={ArrowLeftIcon} onClick={leave}/><span className="notes-save-state" role="status">{state.saving?'저장 중':note.pending?'저장됨':'동기화됨'}</span><span className="notes-top__space"/>
        {canConvert&&<IconButton label={kind==='checklist'?'메모로 바꾸기':'체크리스트로 바꾸기'} icon={kind==='checklist'?DocumentTextIcon:ListBulletIcon} onClick={convert}/>}
        {!note.deleted&&kind==='text'&&!note.readOnly&&<MarkdownHelpButton/>}
        {!note.deleted&&isSecret(note)&&!note.redacted&&<IconButton label="지금 잠그기" icon={LockClosedIcon} onClick={lockSecrets}/>}
        {!note.deleted&&<><IconButton label={note.pinned?'고정 해제':'고정'} icon={PinIcon} active={note.pinned} onClick={()=>edit({pinned:!note.pinned})}/>
          <Button type="button" size="icon" variant="ghost" aria-label="메모 색상" onClick={()=>setSheet('color')}><span className={`notes-color-dot${colorValue?'':' is-empty'}`} style={colorValue?{background:colorValue}:undefined} aria-hidden="true"/></Button>
          <IconButton label="메모 더보기" icon={EllipsisHorizontalIcon} onClick={()=>setSheet('more')}/>
          <IconButton label="메모 휴지통으로" icon={TrashIcon} onClick={()=>{edit({deleted:true});leave();}}/></>}
      </header>
      <div ref={pane} className={`notes-editor${colorValue?' has-tint':''}`} style={tint(note.color)} onClick={event=>{if(editingBody&&event.target===event.currentTarget)stopBodyEdit();}}><div className="notes-editor__inner">
        {note.deleted&&<div className="notes-restore"><span>휴지통에 있는 메모입니다.</span><Button variant="ghost" onClick={()=>edit({deleted:false})}>복원</Button></div>}
        {note.conflictCopy&&<div className="notes-conflict" role="status"><span>다른 기기의 수정과 겹쳐 두 내용을 모두 보관했습니다. 이 메모는 이 태블릿에서 쓴 내용입니다.</span><Button variant="ghost" onClick={()=>void store.dismissConflictCopy(note.id)}>확인</Button></div>}
        {note.readOnly&&<p className="notes-readonly" role="status">새 버전의 앱에서 만든 메모입니다. 앱을 업데이트하면 편집할 수 있습니다.</p>}
        {isSecret(note)&&state.secretLocked&&!note.redacted&&<p className="notes-readonly" role="status">잠금이 풀린 사이 저장하지 못한 변경이 있습니다. PIN을 입력하면 이어서 저장합니다.</p>}
        {limitError&&<p className="notes-limit" role="alert">{limitError}</p>}
        <input ref={titleRef} className="notes-title" aria-label="메모 제목" placeholder={isSecret(note)?'암호 메모 제목':'제목'} maxLength={NOTE_LIMITS.title} value={note.title} readOnly={note.deleted||!!note.readOnly} onChange={event=>edit({title:event.target.value})}/>
        <p className="notes-when">{relativeTime(note.updatedAt)} 수정{note.archived&&' · 보관함'}</p>
        {!note.redacted&&(editable||(note.labels??[]).length>0)&&<LabelEditor key={note.id} labels={note.labels??[]} suggestions={allLabels.map(l=>l.label)} readOnly={!editable} onChange={labels=>edit({labels})}/>}
        {body}
      </div></div>
    </>}
    {/* Always mounted once unlocked so its pull-to-refresh gesture stays attached. */}
    <div className="notes-list-view" style={{display:state.ready&&state.unlocked&&!editing?undefined:'none'}}>
      {scope!=='all'
        ?<header className="notes-top is-sub"><IconButton label="메모 목록으로" icon={ArrowLeftIcon} onClick={()=>setScope('all')}/><h1>{trash?'휴지통':'보관함'}<span className="numeric muted">{trash?trashed:archived}</span></h1></header>
        :<TopBar title="메모" actions={<><span className="notes-save-state" role="status">{status}</span>{syncButton}<IconButton label="메모 목록 더보기" icon={EllipsisHorizontalIcon} onClick={()=>setSheet('list')}/></>}/>}
      <div ref={list} className="notes-scroll">
        {pull}
        {trash?<p className="hint notes-trash-hint">열어서 복원할 수 있습니다.</p>:<form className="library-search notes-search" role="search" onSubmit={event=>{event.preventDefault();(document.activeElement as HTMLElement|null)?.blur();}}><MagnifyingGlassIcon aria-hidden="true"/><input aria-label="메모 검색" placeholder="제목, 본문, 라벨 검색" value={query} onChange={event=>setQuery(event.target.value)}/>{query&&<IconButton label="검색어 지우기" icon={XMarkIcon} onClick={()=>setQuery('')}/>}</form>}
        {!trash&&allLabels.length>0&&<div className="filter-chips notes-label-filter" role="group" aria-label="라벨">{allLabels.map(l=>{const on=!!label&&labelKey(label)===labelKey(l.label);return <button key={labelKey(l.label)} type="button" className={`filter-chip${on?' selected':''}`} aria-pressed={on} onClick={()=>setLabel(on?null:l.label)}>{l.label}<span className="numeric">{l.count}</span></button>;})}</div>}
        {pinned.length>0&&<><h2 className="notes-label"><PinIcon aria-hidden="true"/>고정됨</h2><div className="notes-grid">{pinned.map(card)}</div></>}
        {recent.length>0&&<>{pinned.length>0&&<h2 className="notes-label">최근</h2>}<div className="notes-grid">{recent.map(card)}</div></>}
        {!visible.length&&<div className="empty-state"><h2>{trash?'휴지통이 비어 있습니다':scope==='archive'?'보관한 메모가 없습니다':query||label?'찾는 메모가 없습니다':'아직 메모가 없습니다'}</h2>{scope==='all'&&!query&&!label&&<p>아래 버튼으로 첫 메모를 써 보세요.</p>}</div>}
        {!!state.unreadable&&<p className="hint" role="status">읽을 수 없는 메모 {state.unreadable}개는 목록에서 뺐습니다.</p>}
        {scope==='all'&&archived>0&&<div className="notes-links">
          {archived>0&&<button className="notes-trash-link" onClick={()=>setScope('archive')}><ArchiveBoxIcon aria-hidden="true"/>보관함 <span className="numeric">{archived}</span></button>}
        </div>}
      </div>
      {scope==='all'&&<Button variant="primary" className="notes-fab" onClick={()=>setSheet('new')}><PlusIcon aria-hidden="true"/>새 메모</Button>}
    </div>
    {sheet==='new'&&<BottomSheet title="새 메모" onClose={()=>setSheet(null)}>
      <button className="sheet-option" onClick={()=>newNote('text')}><DocumentTextIcon aria-hidden="true"/>메모</button>
      <button className="sheet-option" onClick={()=>newNote('checklist')}><ListBulletIcon aria-hidden="true"/>체크리스트</button>
      <button className="sheet-option" onClick={()=>newNote('secret')}><LockClosedIcon aria-hidden="true"/>암호 메모</button>
      <button className="sheet-option" onClick={openLedger}><WalletIcon aria-hidden="true"/>가계부</button>
    </BottomSheet>}
    {sheet==='color'&&note&&<BottomSheet title="메모 색상" onClose={()=>setSheet(null)}><div role="radiogroup" aria-label="메모 색상">
      <button className="sheet-option" role="radio" aria-checked={!colorValue} onClick={()=>{edit({color:null});setSheet(null);}}><span className="notes-color-dot is-empty" aria-hidden="true"/>기본<span className="radio-dot"/></button>
      {NOTE_COLORS.map(c=><button key={c.key} className="sheet-option" role="radio" aria-checked={note.color===c.key} onClick={()=>{edit({color:c.key});setSheet(null);}}><span className="notes-color-dot" style={{background:c.value}} aria-hidden="true"/>{c.label}<span className="radio-dot"/></button>)}
    </div></BottomSheet>}
    {sheet==='more'&&note&&<BottomSheet title="메모 더보기" onClose={()=>setSheet(null)}>
      {/* Archive sits here next to 휴지통, away from the everyday actions. */}
      <button className="sheet-option" onClick={()=>{edit({archived:!note.archived});setSheet(null);}}><ArchiveBoxIcon aria-hidden="true"/>{note.archived?'보관 해제':'보관함으로 보내기'}</button>
      <button className="sheet-option" onClick={()=>{setSheet(null);edit({deleted:true});leave();}}><TrashIcon aria-hidden="true"/>휴지통으로 보내기</button>
    </BottomSheet>}
    {/* Rarely used places sit behind the top bar's ⋯, out of the way of the notes. */}
    {sheet==='list'&&<BottomSheet title="메모 더보기" onClose={()=>setSheet(null)}>
      <button className="sheet-option" onClick={()=>{setSheet(null);setScope('trash');}}><TrashIcon aria-hidden="true"/>휴지통 <span className="numeric muted">{trashed}</span></button>
      <button className="sheet-option" onClick={()=>setSheet('recovery')}><KeyIcon aria-hidden="true"/>복구키 보기</button>
    </BottomSheet>}
    {sheet==='recovery'&&<BottomSheet title="메모 복구키" onClose={()=>setSheet(null)}><RecoveryKey store={store}/></BottomSheet>}
    {state.error&&<div className="notes-error" role="alert">{state.error}<Button variant="ghost" onClick={()=>void (state.unlocked?store.sync():store.load())}>다시 시도</Button></div>}
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
