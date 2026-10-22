import { useDelayedBusy } from "../src/shared/useDelayedBusy";
import {displayTime} from '../src/shared/displayDate';
import {useVisibleInterval} from './useVisibleInterval';
import {SIGNAL_FALLBACK_MS,useSyncSignal} from './syncSignals';
import {TopBar} from './TopBar';
import {MoreSheet,type ScreenMenuEntry} from './MoreSheet';
import {useSectionShade} from './SectionShade';
import {useCallback,useEffect,useLayoutEffect,useMemo,useRef,useState,useSyncExternalStore,type CSSProperties,type MutableRefObject} from 'react';
import {TagIcon,ArchiveBoxIcon,ArrowPathIcon,DocumentTextIcon,EyeIcon,EyeSlashIcon,KeyIcon,LockClosedIcon,Squares2X2Icon,PlusIcon,TrashIcon,WalletIcon,XMarkIcon} from '@heroicons/react/24/outline';
import {PinIcon,PinSolidIcon} from '../src/shared/ui/PinIcon';
import {Button,EmptyState,IconButton,SectionLabel,SegmentedControl} from './ui';
import {SectionTool} from './SectionTool';
import {ViewOptionsSection} from '../src/shared/ui/ViewOptionsSection';
import {BottomSheet} from './BottomSheet';
import {usePullToRefresh} from './usePullToRefresh';
import {useLevelMotion} from './motion';
import {checklistMarkdown,labelKey,NOTE_COLORS,NOTE_LIMITS,noteColorValue,noteLimitProblem,normalizeLabel,type NoteKind} from '../src/notes/model';
import {MemoEditor} from '../src/notes/memo/MemoEditor';
import {memoBody,memoItems,memoMode,parseMemo,switchMode} from '../src/notes/memo/memoModel';
import {isSecret,noteKind,rebaseList,NotesStore,PIN_REQUIRED_TEXT,type Note} from '../src/notes/store';
import {genericView,hiddenLedgerMonths,LEDGER} from '../src/notes/ledger/model';
import {noteMatches,sortNotes} from '../src/notes/noteList';
import {noteDateLabel} from '../src/notes/format';
import {NOTE_KIND_DEFINITIONS,type NoteKindFilter} from '../src/notes/noteFilters';
import {NoteCard} from '../src/notes/NoteCard';
import {NoteLedger} from './NoteLedger';
import {copySecret,SecretEditor,SecretGate} from './NoteSecret';
import {QR_VIEWBOX_SIZE,createQrMatrix,qrSvgPath} from '../src/shared/ui/qrCode';
import {revealCaret,useNoteEditor} from './noteCaret';
import '../src/notes/noteCard.css';
import './notes.css';
import {Scrubber} from './Scrubber';

/** A decrypted note as native returns it (Notes v2 fields are optional: v1 notes lack them). */
export type MobileNote=Note;
/** Secret notes lock again after this much inactivity (native enforces the same). */
export const SECRET_IDLE_MS=5*60_000;
const SECRET_TOUCH_MS=60_000;

import {mobileNotesRequest} from './notesTransport';
export {mobileNotesRequest} from './notesTransport';

type Scope='all'|'pinned'|'archive'|'trash';
type Sheet='new'|'color'|'more'|'list'|'view'|'recovery'|null;
const tint=(color:string|null|undefined)=>{const value=noteColorValue(color);return value?({'--note-tint':value} as CSSProperties):undefined;};
/** The bottom quick-add field was removed (user, 2026-10-03); clear its device preferences once. */
function clearQuickSectionPreferences(){
  try {for(const key of Object.keys(localStorage))if(key.startsWith('lakomics.notes.quickSection.'))localStorage.removeItem(key);}catch{/* Device preferences are optional. */}
}
clearQuickSectionPreferences();
function LabelEditor({labels,suggestions,readOnly,onChange}:{labels:string[];suggestions:string[];readOnly:boolean;onChange(labels:string[]):void}) {
  const editor=useNoteEditor();
  const [adding,setAdding]=useState(false),[text,setText]=useState('');
  function commit(close:boolean,value=text){
    const label=normalizeLabel(value);
    if(label&&labels.length<NOTE_LIMITS.labels&&!labels.some(entry=>labelKey(entry)===labelKey(label)))onChange([...labels,label]);
    setText('');if(close)setAdding(false);
  }
  return <div className="notes-labels" aria-label="라벨">
    {labels.map(label=><span key={label} className="notes-label-chip">{label}{!readOnly&&<button type="button" aria-label={`${label} 라벨 빼기`} onClick={()=>onChange(labels.filter(entry=>entry!==label))}><XMarkIcon aria-hidden="true"/></button>}</span>)}
    {!readOnly&&(adding?<>
      <input className="notes-label-input" aria-label="라벨 추가" list="notes-label-options" autoFocus maxLength={NOTE_LIMITS.labelChars} {...editor.bind(text,setText)} enterKeyHint="done"
        onBlur={event=>{if(!editor.isComposing(event.currentTarget))commit(true,event.currentTarget.value);}} onKeyDown={event=>{if(editor.isComposing(event.currentTarget)||event.nativeEvent.isComposing||event.keyCode===229)return;if(event.key==='Enter'){event.preventDefault();commit(false,event.currentTarget.value);event.currentTarget.value='';}}}/>
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
  const showLoading = useDelayedBusy(key === null && !needPin && !error);
  // Encoded here, offline, as the PC shows it; the key never leaves the device for a QR.
  const qr=useMemo(()=>key?qrSvgPath(createQrMatrix(key)):'',[key]);
  return <div className="notes-recovery">
    {key!==null&&!showLoading?<>
      {qr&&<svg className="notes-recovery__qr" role="img" aria-label="복구키 QR 코드" viewBox={`0 0 ${QR_VIEWBOX_SIZE} ${QR_VIEWBOX_SIZE}`} shapeRendering="crispEdges"><rect width={QR_VIEWBOX_SIZE} height={QR_VIEWBOX_SIZE} fill="#f2f0e8"/><path d={qr} fill="#171816"/></svg>}
      <textarea className="notes-recovery__key" aria-label="복구키" value={key} readOnly spellCheck={false}/>
      <p className="hint">다른 기기에서는 QR을 카메라로 찍거나 키를 복사해 붙여넣으세요. 다른 사람이 보지 않는 곳에서 열고, 따로 보관해 주세요. 복사한 키는 30초 뒤 클립보드에서 지웁니다.</p>
      <Button onClick={()=>void copySecret(key).then(()=>setCopied(true),()=>setError('복사하지 못했습니다.'))}>{copied?'복사했습니다':'복구키 복사'}</Button>
    </>:needPin?<form onSubmit={event=>{event.preventDefault();void unlockAndReveal();}}>
      <label>암호 메모 PIN<input className="notes-secret-gate__pin" type="password" inputMode="numeric" autoComplete="off" maxLength={8} value={pin} onChange={event=>setPin(event.target.value.replace(/\D/g,''))}/></label>
      <p className="hint">복구키로 PIN을 바꿀 수 있어서, 보려면 이 태블릿의 PIN이 필요합니다.</p>
      <Button type="submit" variant="primary" disabled={pin.length<4}>확인 후 복구키 보기</Button>
    </form>:showLoading&&!error&&<p className="hint">불러오는 중…</p>}
    {error&&<p role="alert" className="notes-secret-gate__error">{error}</p>}
  </div>;
}

/** `onReturnHome`: set while a note was opened from Home; leaving that note returns there.
 *  `onHomeEntryGone`: called when that note is trashed or the list is used instead, so App forgets
 *  the Home origin and Notes behaves like a normal tab visit from then on. */
export function Notes({active,backRef,request,onReturnHome,onHomeEntryGone,findStore}:{active:boolean;findStore?:NotesStore;backRef:MutableRefObject<(()=>boolean)|null>;request?:{id:string;key:number}|null;onReturnHome?:()=>void;onHomeEntryGone?:()=>void}) {
  useEffect(clearQuickSectionPreferences,[]);
  const [store]=useState(()=>findStore??new NotesStore(mobileNotesRequest));
  const state=useSyncExternalStore(store.subscribe,store.snapshot);
  const [key,setKey]=useState('');
  const [selected,setSelected]=useState<string|null>(null),[scope,setScope]=useState<Scope>('all'),[label,setLabel]=useState<string|null>(null),[query,setQuery]=useState(''),[kindFilter,setKindFilter]=useState<NoteKindFilter>('all');
  const [creatingSecret,setCreatingSecret]=useState(false),[sheet,setSheet]=useState<Sheet>(null),[limitError,setLimitError]=useState<string|null>(null);
  const titleRef=useRef<HTMLInputElement>(null),pane=useRef<HTMLDivElement>(null);
  useEffect(()=>{void store.load();},[store]);
  const trash=scope==='trash';
  const found=state.notes.find(n=>n.id===selected)??null;
  // A live ledger opens its own screens; a trashed one and a month note whose ledger is gone
  // stay read-only with their text fallback (pin, trash, archive and restore still work).
  const ledgerOpen=!!found&&found.type===LEDGER&&!found.deleted&&!found.readOnly;
  const currentNote=ledgerOpen?found:genericView(found);
  const [compositionNote,setCompositionNote]=useState<Note|null>(null);
  const note=compositionNote?.id===selected&&currentNote&&!currentNote.redacted?{...currentNote,body:compositionNote.body,items:compositionNote.items,fields:compositionNote.fields}:currentNote;
  const editor=useNoteEditor();
  const ledgerBack=useRef<(()=>boolean)|null>(null);
  // MemoEditor's own dialogs and menus take the back gesture before the note closes.
  const memoBack=useRef<(()=>boolean)|null>(null);
  // Month notes live inside their ledger: out of the list, 보관함, labels and counts.
  const hiddenMonths=useMemo(()=>hiddenLedgerMonths(state.notes),[state.notes]);
  const listed=useMemo(()=>state.notes.filter(n=>!hiddenMonths.has(n.id)),[state.notes,hiddenMonths]);
  // ---- Sync: at once when Notes opens, every minute (or when `signals.notes` moves while the
  // status long-poll is live, with a 10 min fallback), and backing off while writes wait.
  const pending=state.notes.some(n=>n.pending);
  const [retryDelay,setRetryDelay]=useState(2000);
  useEffect(()=>{setRetryDelay(2000);},[pending]);
  const notesSignalled=useSyncSignal('notes',()=>void store.sync('background'),active&&state.unlocked&&!pending);
  useVisibleInterval(()=>void store.sync('background'),active&&state.unlocked&&!pending?(notesSignalled?SIGNAL_FALLBACK_MS:60_000):null,true);
  useVisibleInterval(()=>{void store.sync('background').finally(()=>setRetryDelay(delay=>Math.min(60_000,delay*2)));},active&&state.unlocked&&pending?retryDelay:null);
  useEffect(()=>{const leave=()=>{if(document.visibilityState==='hidden')void store.finish();};document.addEventListener('visibilitychange',leave);return()=>document.removeEventListener('visibilitychange',leave);},[store]);
  // ---- Secret notes lock after 5 idle minutes, when the app goes to the background (native
  // locks in onStop and tells the page), when Notes is left, and when the note is closed.
  const revealed=state.notes.some(n=>isSecret(n)&&!n.redacted);
  const snapshotSensitive=active&&(sheet==='recovery'||creatingSecret||!!note&&isSecret(note)||revealed);
  useLayoutEffect(()=>{
    window.LakomicsNative?.setResumeSnapshotSensitive?.(snapshotSensitive);
    return()=>window.LakomicsNative?.setResumeSnapshotSensitive?.(false);
  },[snapshotSensitive]);
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
  // Leaving the 메모 screen finishes the work: one sync of what was edited.
  useEffect(()=>{if(!active)void store.finish();},[active,store]);
  useEffect(()=>()=>{void store.lockSecrets();},[store]);
  const notesRef=useRef(state.notes);notesRef.current=state.notes;
  const previous=useRef<string|null>(null);
  useEffect(()=>{
    const before=notesRef.current.find(n=>n.id===previous.current),now=notesRef.current.find(n=>n.id===selected);
    // Closing a note or switching to another one is the moment to sync it.
    if(previous.current&&previous.current!==selected)void store.finish();
    previous.current=selected;
    // Moving straight to another secret note keeps the session.
    if(before&&isSecret(before)&&before.id!==selected&&!(now&&isSecret(now)))lockSecrets();
  },[selected,lockSecrets,store]);
  useEffect(()=>{if(!state.moved||compositionNote)return;if(selected===state.moved.from)setSelected(state.moved.to);store.clearMoved();},[state.moved,selected,store,compositionNote]);
  // ---- Navigation
  const select=(id:string|null)=>{setCompositionNote(null);setCreatingSecret(false);setSelected(id);setLimitError(null);};
  // Home opens a note by id (its pinned rows); each request opens once.
  useEffect(()=>{if(request){setSheet(null);setScope('all');setLabel(null);setQuery('');select(request.id);}},[request?.key]);
  const leave=()=>{select(null);void store.finish();};
  // Back and the list arrow: a note opened from Home goes back to Home, not to the list.
  const close=()=>{leave();onReturnHome?.();};
  // Trashing leaves the user on the list; a note opened from there later closes back to it.
  const trashNote=()=>{edit({deleted:true});leave();onHomeEntryGone?.();};
  const openFromList=(id:string)=>{onHomeEntryGone?.();select(id);};
  const kind=note?noteKind(note):'text';
  const editable=!!note&&!note.deleted&&!note.readOnly&&!note.redacted;
  useEffect(()=>{backRef.current=()=>{
    if(memoBack.current?.())return true;
    if(sheet){setSheet(null);return true;}
    if(ledgerOpen&&ledgerBack.current?.())return true;
    if(creatingSecret){setCreatingSecret(false);return true;}
    if(selected){close();return true;}
    if(scope!=='all'){setScope('all');return true;}
    if(label){setLabel(null);return true;}
    return false;
  };return()=>{backRef.current=null;};});
  function newNote(kind:NoteKind){
    setSheet(null);setScope('all');setLabel(null);setQuery('');onHomeEntryGone?.();
    if(kind==='secret'&&!revealed){setSelected(null);setCreatingSecret(true);return;}
    select(store.create(kind));
    if(kind==='secret')requestAnimationFrame(()=>titleRef.current?.focus());
  }
  /** One 가계부: opens the existing ledger, restores it from the trash, or creates it (pinned). */
  function openLedger(){
    setSheet(null);setScope('all');setLabel(null);setQuery('');onHomeEntryGone?.();
    const ledgers=state.notes.filter(n=>n.type===LEDGER&&!n.readOnly).sort((a,b)=>a.createdAt.localeCompare(b.createdAt));
    const existing=ledgers.find(n=>!n.deleted),trashed=ledgers.find(n=>n.deleted);
    if(!existing&&trashed)store.edit({...trashed,deleted:false});
    select(existing?existing.id:trashed?trashed.id:store.create(LEDGER));
  }
  const memoSource=note?(kind==='checklist'?checklistMarkdown(note.items??[])||'- [ ]':note.body):'';
  const memoEditingMode=memoMode(memoSource);
  function edit(change:Partial<Note>){
    if(!note)return false;
    if(kind==='checklist')change={type:'text',body:memoSource,items:undefined,...change};
    const snapshot=store.snapshot(),id=snapshot.moved?.from===note.id?snapshot.moved.to:note.id;
    const latest=snapshot.notes.find(entry=>entry.id===id)??note;
    if(change.items)change={...change,items:rebaseList(latest.items??[],note.items??[],change.items)};
    if(change.fields)change={...change,fields:rebaseList(latest.fields??[],note.fields??[],change.fields)};
    const problem=noteLimitProblem({...latest,...change});setLimitError(problem);
    if(problem)return false;
    store.edit({...latest,...change});return true;
  }
  // ---- Keyboard: fit the editor to the visible area above the keyboard and keep the caret in view.
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
      requestAnimationFrame(()=>revealCaret(pane.current));
    };
    update();
    viewport.addEventListener('resize',update);
    viewport.addEventListener('scroll',update);
    window.addEventListener('resize',update);
    return()=>{viewport.removeEventListener('resize',update);viewport.removeEventListener('scroll',update);window.removeEventListener('resize',update);};
  },[active,selected]);
  useLayoutEffect(()=>{revealCaret(pane.current);},[note?.body,selected]);
  const editing=!!(selected&&note)||creatingSecret;
  useLevelMotion(section,active&&state.ready&&state.unlocked?(editing?'edit':scope!=='all'?scope:'list'):null,(editing?1:0)+(scope!=='all'?1:0));
  // ---- List
  const allLabels=useMemo(()=>{const map=new Map<string,{label:string;count:number}>();for(const n of listed)if(!n.deleted)for(const l of n.labels??[]){const k=labelKey(l);const e=map.get(k);if(e)e.count++;else map.set(k,{label:l,count:1});}return [...map.values()].sort((a,b)=>a.label.localeCompare(b.label,'ko'));},[listed]);
  const filterable=listed.filter(n=>(trash?n.deleted:!n.deleted&&(scope==='archive'?!!n.archived:!n.archived))&&(scope!=='pinned'||n.pinned)&&(trash||!label||(n.labels??[]).some(l=>labelKey(l)===labelKey(label)))&&noteMatches(n,trash?'':query));
  const kindOptions=[{value:'all' as const,label:'전체'},...NOTE_KIND_DEFINITIONS.filter(([value])=>value!=='checklist').map(([value,label])=>({value,label}))];
  const visible=sortNotes(filterable.filter(n=>kindFilter==='all'||(noteKind(n)==='checklist'?'text':noteKind(n))===kindFilter));
  // The kinds are the list's first row; scrolled away, the top bar pulls them down.
  const kinds=useSectionShade<NoteKindFilter>({label:'메모 종류',options:kindOptions,value:kindFilter,onChange:setKindFilter,trailing:<><SectionTool label="새 메모" icon={PlusIcon} onClick={()=>setSheet('new')}/><SectionTool label="보기" icon={Squares2X2Icon} onClick={()=>setSheet('view')}/></>},{active:active&&state.ready&&state.unlocked&&!editing});
  const pinned=scope!=='all'?[]:visible.filter(n=>n.pinned),recent=scope!=='all'?visible:visible.filter(n=>!n.pinned);
  const trashed=listed.filter(n=>n.deleted).length,archived=listed.filter(n=>!n.deleted&&n.archived).length;
  // Local saves remain immediate; an open editor only announces errors.
  const syncTime=state.lastSyncedAt?displayTime(state.lastSyncedAt):'';
  const listEntries:ScreenMenuEntry[]=[
    {id:'sync',group:'action',label:`지금 동기화${syncTime?` · ${syncTime}`:''}`,icon:<ArrowPathIcon/>,disabled:state.syncing,run:()=>{if(!state.syncing)void store.sync();}},
    {id:'recovery',group:'action',label:'복구키 보기',icon:<KeyIcon/>,run:()=>setSheet('recovery')},
  ];
  const list=useRef<HTMLDivElement>(null);
  const scrubberSort=useMemo(()=>({kind:'date' as const,values:visible.map(note=>note.updatedAt)}),[visible]);
  const pull=usePullToRefresh(list,()=>void store.sync(),state.syncing,!active||!state.unlocked||editing);
  // A dot marks a note still waiting to sync; the words are there for screen readers.
  const card=(n:Note)=><NoteCard key={n.id} note={n} notes={state.notes} onOpen={openFromList}/>;

  // ---- Editor body
  const colorValue=note?noteColorValue(note.color):null;
  const body=!note?null:isSecret(note)&&state.secretLocked&&!note.redacted?<SecretGate key={`resume-${note.id}`} store={store} onOpened={()=>store.resumeSecretSaves()}/>
    :isSecret(note)?(note.redacted?<SecretGate key={note.id} store={store} onOpened={()=>void store.refresh()}/>
      :<SecretEditor fields={note.fields??[]} memo={note.memo??''} readOnly={!editable} onChange={change=>edit(change)}/>)
    :<MemoEditor noteId={note.id} body={memoSource} touch readOnly={!editable} onChange={body=>edit({body})} backRef={memoBack}/>;
  const memoTasks=memoItems(parseMemo(memoSource)).filter(item=>item.task);
  // Only to-do progress earns a footer; a text memo has no length limit worth counting.
  const footer=note&&!isSecret(note)&&memoEditingMode==='todo'?`${memoTasks.filter(item=>item.done).length}/${memoTasks.length} 완료`:null;
  return <section ref={section} className={`mobile-notes ${editing?'note-open':''}`} style={{display:active?undefined:'none',maxHeight:selected&&note?editorHeight:undefined}} aria-label="메모" onCompositionStartCapture={()=>setCompositionNote(currentNote)} onCompositionEndCapture={()=>setCompositionNote(null)}>
    {!state.ready?<TopBar title="메모" loading="메모 불러오는 중"/>:!state.unlocked?<>
      <TopBar title="메모"/>
      <form className="notes-unlock" onSubmit={event=>{event.preventDefault();void store.unlock(key).then(ok=>{if(ok)setKey('');});}}><h2>메모 연결</h2><p>PC 메모에서 사용하는 복구 키를 한 번 입력하세요.</p><input type="password" aria-label="메모 복구 키" value={key} autoComplete="off" spellCheck={false} autoCapitalize="none" onChange={event=>setKey(event.target.value)}/><Button type="submit" variant="primary" disabled={key.trim().length!==64}>메모 열기</Button></form>
    </>:null}
    {state.ready&&state.unlocked&&creatingSecret&&!note&&<>
      <TopBar back={{label:'메모 목록',onClick:()=>setCreatingSecret(false)}} title="암호 메모"/>
      <div className="notes-editor"><SecretGate store={store} onOpened={()=>{setCreatingSecret(false);select(store.create('secret'));requestAnimationFrame(()=>titleRef.current?.focus());}} onCancel={()=>setCreatingSecret(false)}/></div>
    </>}
    {state.ready&&state.unlocked&&note&&ledgerOpen&&<NoteLedger store={store} ledger={note} notes={state.notes} backRef={ledgerBack} onLeave={close} onMore={()=>setSheet('more')}
      loading={!state.error&&(state.saving||state.syncing)&&(state.saving?'저장 중':'동기화 중')}/>}
    {state.ready&&state.unlocked&&note&&!ledgerOpen&&<>
      <TopBar back={{label:'메모 목록',onClick:close}} crumbs={<button className="top-bar__crumbs" onClick={close}>메모 ›</button>} itemAction={!note.deleted?<IconButton label={note.pinned?'고정 해제':'고정'} icon={PinIcon} activeIcon={PinSolidIcon} active={note.pinned} onClick={()=>edit({pinned:!note.pinned})}/>:undefined} onMenu={()=>setSheet('more')} loading={!state.error&&(state.saving||state.syncing)&&(state.saving?'저장 중':'동기화 중')}/>
      <div key={note.id} ref={pane} className={`notes-editor${colorValue?' has-tint':''}`} style={tint(note.color)} onInput={()=>revealCaret(pane.current)} onFocus={()=>revealCaret(pane.current)}><div className="notes-editor__inner">
        {note.deleted&&<div className="notes-restore"><span>휴지통에 있는 메모입니다.</span><Button variant="ghost" onClick={()=>edit({deleted:false})}>복원</Button></div>}
        {note.conflictCopy&&<div className="notes-conflict" role="status"><span>다른 기기의 수정과 겹쳐 두 내용을 모두 보관했습니다. 이 메모는 이 태블릿에서 쓴 내용입니다.</span><Button variant="ghost" onClick={()=>void store.dismissConflictCopy(note.id)}>확인</Button></div>}
        {note.readOnly&&<p className="notes-readonly" role="status">새 버전의 앱에서 만든 메모입니다. 앱을 업데이트하면 편집할 수 있습니다.</p>}
        {isSecret(note)&&state.secretLocked&&!note.redacted&&<p className="notes-readonly" role="status">잠금이 풀린 사이 저장하지 못한 변경이 있습니다. PIN을 입력하면 이어서 저장합니다.</p>}
        {limitError&&<p className="notes-limit" role="alert">{limitError}</p>}
        <div className="notes-title-row">
          <input className="notes-title" aria-label="메모 제목" placeholder={isSecret(note)?'암호 메모 제목':'제목'} maxLength={NOTE_LIMITS.title} {...editor.bind(note.title,value=>edit({title:value}),titleRef)} readOnly={note.deleted||!!note.readOnly}/>
          {!isSecret(note)&&(editable?<SegmentedControl label="메모 방식" options={[{value:'text',label:'글'},{value:'todo',label:'할 일'}]} value={memoEditingMode} onChange={mode=>{
            if(mode!==memoEditingMode&&!compositionNote)edit({type:'text',items:undefined,body:memoBody(switchMode(parseMemo(memoSource),mode))});
          }}/>:<span>{memoEditingMode==='todo'?'할 일':'글'}</span>)}
        </div>
        <p className="notes-when">{noteDateLabel(note.updatedAt)} 수정{note.archived&&' · 보관함'}</p>
        {!note.redacted&&(editable||(note.labels??[]).length>0)&&<LabelEditor key={note.id} labels={note.labels??[]} suggestions={allLabels.map(l=>l.label)} readOnly={!editable} onChange={labels=>edit({labels})}/>}
        {body}
        {footer&&<p className="notes-memo-footer">{footer}</p>}
      </div></div>
    </>}
    {/* Always mounted once unlocked so its pull-to-refresh gesture stays attached. */}
    <div className="notes-list-view" style={{display:state.ready&&state.unlocked&&!editing?undefined:'none'}}>
      {scope!=='all'
        ?<TopBar barRef={kinds.barRef} back={{label:'메모 목록으로',onClick:()=>setScope('all')}} crumbs={<button className="top-bar__crumbs" onClick={()=>setScope('all')}>메모 ›</button>} title={kinds.title(trash?'휴지통':scope==='pinned'?'고정':'보관함')} count={trash?trashed:scope==='pinned'?visible.length:archived} search={!trash?{scope:'메모',run:setQuery}:undefined} onMenu={()=>setSheet('list')} loading={!state.error&&(state.saving||state.syncing)&&(state.saving?'저장 중':'동기화 중')}/>
        :<TopBar barRef={kinds.barRef} title={kinds.title('메모')} search={{scope:'메모',run:setQuery}} onMenu={()=>setSheet('list')} loading={!state.error&&(state.saving||state.syncing)&&(state.saving?'저장 중':'동기화 중')}/>}
      {kinds.shade}
      <div ref={list} className="notes-scroll">
        {pull}
        {kinds.inline}
        {trash&&<p className="hint notes-trash-hint">열어서 복원할 수 있습니다.</p>}
        {!trash&&query&&<div className="notes-search-result" role="status"><span>‘{query}’ 검색 결과</span><Button size="sm" variant="quiet" onClick={()=>setQuery('')}>해제</Button></div>}
        {label&&<div className="notes-search-result"><span>라벨 · {label}</span><Button size="sm" variant="quiet" onClick={()=>setLabel(null)}>라벨 해제</Button></div>}
        {pinned.length>0&&<><SectionLabel as="h2" className="notes-board__label" title="고정됨"/><div className="notes-grid">{pinned.map(card)}</div></>}
        {recent.length>0&&<>{pinned.length>0&&<SectionLabel as="h2" className="notes-board__label" title="최근"/>}<div className="notes-grid">{recent.map(card)}</div></>}
        {!visible.length&&<EmptyState title={trash?'휴지통이 비어 있습니다':scope==='archive'?'보관한 메모가 없습니다':query?'검색 결과 없음':label?'찾는 메모가 없습니다':'아직 메모가 없습니다'} hint={scope==='all'&&!query&&!label&&'+ 버튼으로 첫 메모를 써 보세요.'}/>}
        {!!state.unreadable&&<p className="hint" role="status">읽을 수 없는 메모 {state.unreadable}개는 목록에서 뺐습니다.</p>}
        <Scrubber scrollRef={list} total={visible.length} sort={scrubberSort} hidden={!active||!!note||sheet!==null}/>
      </div>
    </div>
    {sheet==='new'&&<BottomSheet title="새 메모" onClose={()=>setSheet(null)}>
      <button className="sheet-option" onClick={()=>newNote('text')}><DocumentTextIcon aria-hidden="true"/>메모</button>
      <button className="sheet-option" onClick={()=>newNote('secret')}><LockClosedIcon aria-hidden="true"/>암호 메모</button>
      <button className="sheet-option" onClick={openLedger}><WalletIcon aria-hidden="true"/>가계부</button>
    </BottomSheet>}
    {sheet==='view'&&<BottomSheet title="보기" onClose={()=>setSheet(null)}><div className="ui-view-options__content">
      <ViewOptionsSection title="보기"><div role="radiogroup" aria-label="메모 범위">{([['all','모든 메모'],['pinned','고정'],['archive','보관함'],['trash','휴지통']] as const).map(([value,title])=><button key={value} className="sheet-option" role="radio" aria-checked={scope===value&&!label} onClick={()=>{setScope(value);setLabel(null);setSheet(null);}}>{title}<span className="radio-dot"/></button>)}</div></ViewOptionsSection>
      <ViewOptionsSection title="라벨">{allLabels.map(entry=><button key={labelKey(entry.label)} className="sheet-option" aria-pressed={!!label&&labelKey(label)===labelKey(entry.label)} onClick={()=>{setLabel(entry.label);setScope('all');setSheet(null);}}><TagIcon aria-hidden="true"/>{entry.label}<span className="numeric">{entry.count}</span></button>)}{!allLabels.length&&<p className="hint">라벨이 없습니다.</p>}</ViewOptionsSection>
    </div></BottomSheet>}
    {sheet==='color'&&note&&<BottomSheet title="메모 색상" onClose={()=>setSheet(null)}><div role="radiogroup" aria-label="메모 색상">
      <button className="sheet-option" role="radio" aria-checked={!colorValue} onClick={()=>{edit({color:null});setSheet(null);}}><span className="notes-color-dot is-empty" aria-hidden="true"/>기본<span className="radio-dot"/></button>
      {NOTE_COLORS.map(c=><button key={c.key} className="sheet-option" role="radio" aria-checked={note.color===c.key} onClick={()=>{edit({color:c.key});setSheet(null);}}><span className="notes-color-dot" style={{background:c.value}} aria-hidden="true"/>{c.label}<span className="radio-dot"/></button>)}
    </div></BottomSheet>}
    {sheet==='more'&&note&&<MoreSheet screenTitle={note.title||'메모'} onClose={()=>setSheet(null)} screenEntries={[
      ...(!note.deleted?[
        ...(isSecret(note)&&!note.redacted?[{id:'lock',group:'action' as const,label:'지금 잠그기',icon:<LockClosedIcon/>,run:lockSecrets}]:[]),
        {id:'color',group:'action' as const,label:'메모 색상',icon:<DocumentTextIcon/>,run:()=>setSheet('color')},
        ...((kind==='text'||kind==='checklist')&&editable?[{id:'conceal',group:'action' as const,label:note.concealed?'목록에서 내용 보이기':'목록에서 내용 숨기기',icon:note.concealed?<EyeIcon/>:<EyeSlashIcon/>,run:()=>edit({concealed:!note.concealed})}]:[]),
        {id:'archive',group:'action' as const,label:note.archived?'보관 해제':'보관함으로 보내기',icon:<ArchiveBoxIcon/>,run:()=>edit({archived:!note.archived})},
        {id:'trash-note',group:'action' as const,label:'휴지통으로',icon:<TrashIcon/>,run:trashNote},
      ]:[]),...listEntries,
    ]}/>}
    {sheet==='list'&&<MoreSheet screenTitle="메모" screenEntries={listEntries} onClose={()=>setSheet(null)}/>}
    {sheet==='recovery'&&<BottomSheet title="메모 복구키" onClose={()=>setSheet(null)}><RecoveryKey store={store}/></BottomSheet>}
    {state.error&&<div className="notes-error" role="alert">{state.error}<Button variant="ghost" onClick={()=>void (state.unlocked?store.sync():store.load())}>다시 시도</Button></div>}
  </section>;
}
