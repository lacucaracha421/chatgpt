import {ClipboardDocumentIcon,EyeIcon,EyeSlashIcon,FingerPrintIcon,LockClosedIcon,PlusIcon,XMarkIcon} from '@heroicons/react/24/outline';
import {useEffect,useLayoutEffect,useRef,useState} from 'react';
import {byOrder,keyBetween,NOTE_LIMITS,type SecretField} from '../src/notes/model';
import type {NotesStore,SecretStatus} from '../src/notes/store';
import {native} from './transport';
import {Button,IconButton} from './ui';

export const REVEAL_MS=10_000;
/**
 * Copies a secret natively: the clip is marked sensitive (hidden from clipboard previews)
 * and native clears it after 30 s if the clipboard still holds it. Never logged.
 */
export function copySecret(text:string){return native('notesCopySecret',{text});}
const pinPattern=/^\d{4,8}$/;
type Status=SecretStatus&{biometric?:boolean};

/**
 * Opens secret notes on this tablet: fingerprint (offered at once when enrolled) or the
 * device PIN; first use sets the PIN; "PIN을 잊었나요?" resets it with the recovery key.
 */
export function SecretGate({store,onOpened,onCancel}:{store:NotesStore;onOpened():void;onCancel?():void}) {
  const [status,setStatus]=useState<Status|null>(null);
  const [mode,setMode]=useState<'enter'|'reset'>('enter');
  const [pin,setPin]=useState(''),[confirm,setConfirm]=useState(''),[recovery,setRecovery]=useState('');
  const [busy,setBusy]=useState(false),[error,setError]=useState('');
  const opened=useRef(onOpened);opened.current=onOpened;
  const prompted=useRef(false);
  useEffect(()=>{
    let live=true;
    store.secretStatus().then(next=>{if(!live)return;if(next.unlocked)opened.current();else setStatus(next as Status);})
      .catch((e:unknown)=>live&&setError(typeof e==='string'?e:'암호 메모 상태를 확인하지 못했습니다.'));
    return()=>{live=false;};
  },[store]);
  async function fingerprint(){
    setError('');setBusy(true);
    const failure=await store.openSecrets('secretUnlock',{biometric:'true'});
    setBusy(false);
    if(failure)setError(failure);else opened.current();
  }
  // Offer the fingerprint prompt at once; the PIN stays available underneath.
  useEffect(()=>{if(status?.pinSet&&status.biometric&&mode==='enter'&&!prompted.current){prompted.current=true;void fingerprint();}},[status,mode]);
  const creating=status!==null&&(!status.pinSet||mode==='reset');
  async function submit(){
    setError('');
    if(!pinPattern.test(pin))return setError('PIN은 숫자 4~8자리로 입력해 주세요.');
    if(creating&&pin!==confirm)return setError('두 PIN이 다릅니다.');
    setBusy(true);
    const failure=await store.openSecrets(mode==='reset'?'secretResetPin':status?.pinSet?'secretUnlock':'secretSetPin',mode==='reset'?{recoveryKey:recovery,pin}:{pin});
    setBusy(false);setPin('');setConfirm('');
    if(failure)setError(failure);else opened.current();
  }
  if(!status)return <div className="notes-secret-gate" aria-busy={!error}>{error?<p role="alert">{error}</p>:<p>확인하는 중…</p>}</div>;
  const title=mode==='reset'?'PIN 다시 설정':status.pinSet?'암호 메모 열기':'암호 메모 PIN 만들기';
  return <form className="notes-secret-gate" onSubmit={event=>{event.preventDefault();void submit();}}>
    <LockClosedIcon className="notes-secret-gate__icon" aria-hidden="true"/>
    <h2>{title}</h2>
    <p>{mode==='reset'?'메모 복구키로 이 태블릿의 PIN을 새로 정합니다.':status.pinSet?'이 태블릿에서 정한 PIN을 입력하세요.':'이 태블릿에서만 쓰는 숫자 4~8자리 PIN입니다. 다른 기기와 동기화되지 않습니다.'}</p>
    {mode==='enter'&&status.pinSet&&status.biometric&&<Button type="button" variant="ghost" disabled={busy} onClick={()=>void fingerprint()}><FingerPrintIcon aria-hidden="true"/>지문으로 열기</Button>}
    {mode==='reset'&&<label>복구키<textarea className="notes-secret-gate__key" value={recovery} spellCheck={false} autoComplete="off" autoCapitalize="none" onChange={event=>setRecovery(event.target.value)}/></label>}
    <label>{creating?'새 PIN':'PIN'}<input className="notes-secret-gate__pin" type="password" inputMode="numeric" autoComplete="off" maxLength={8} value={pin} onChange={event=>setPin(event.target.value.replace(/\D/g,''))}/></label>
    {creating&&<label>PIN 확인<input className="notes-secret-gate__pin" type="password" inputMode="numeric" autoComplete="off" maxLength={8} value={confirm} onChange={event=>setConfirm(event.target.value.replace(/\D/g,''))}/></label>}
    {error&&<p role="alert" className="notes-secret-gate__error">{error}</p>}
    <div className="notes-secret-gate__actions">
      <Button type="submit" variant="primary" disabled={busy||!pin||(mode==='reset'&&recovery.trim().length!==64)}>{creating?'PIN 설정':'열기'}</Button>
      {status.pinSet&&<Button type="button" variant="ghost" onClick={()=>{setMode(mode==='reset'?'enter':'reset');setError('');}}>{mode==='reset'?'PIN 입력으로':'PIN을 잊었나요?'}</Button>}
      {onCancel&&<Button type="button" variant="ghost" onClick={onCancel}>취소</Button>}
    </div>
  </form>;
}

/** Unlocked secret note: masked values with 보기 (10 s) and 복사, plus the free-text memo. */
export function SecretEditor({fields,memo,readOnly,onChange}:{fields:SecretField[];memo:string;readOnly?:boolean;onChange(change:{fields?:SecretField[];memo?:string}):void}) {
  const sorted=[...fields].sort(byOrder);
  const [revealed,setRevealed]=useState<string|null>(null);
  const [copied,setCopied]=useState<string|null>(null),[copyError,setCopyError]=useState('');
  const focus=useRef<string|null>(null);const listRef=useRef<HTMLUListElement>(null);
  useEffect(()=>{if(!revealed)return;const timer=setTimeout(()=>setRevealed(null),REVEAL_MS);return()=>clearTimeout(timer);},[revealed]);
  useEffect(()=>{if(!copied)return;const timer=setTimeout(()=>setCopied(null),3000);return()=>clearTimeout(timer);},[copied]);
  useLayoutEffect(()=>{if(!focus.current)return;listRef.current?.querySelector<HTMLInputElement>(`input[data-field-label="${focus.current}"]`)?.focus();focus.current=null;});
  const update=(id:string,change:Partial<SecretField>)=>onChange({fields:fields.map(field=>field.id===id?{...field,...change}:field)});
  function add(){
    if(fields.length>=NOTE_LIMITS.fields)return;
    const id=crypto.randomUUID();focus.current=id;
    onChange({fields:[...fields,{id,label:'',value:'',order:keyBetween(sorted[sorted.length-1]?.order??null,null)}]});
  }
  async function copy(field:SecretField){
    setCopyError('');
    try{await copySecret(field.value);setCopied(field.id);}catch{setCopied(null);setCopyError('복사하지 못했습니다.');}
  }
  return <div className="notes-secret">
    <ul ref={listRef} className="notes-secret__fields" aria-label="암호 항목">
      {sorted.map(field=>{const shown=revealed===field.id;return <li key={field.id} className="notes-secret__field">
        <input className="notes-secret__label" data-field-label={field.id} aria-label="항목 이름" placeholder="항목 이름" value={field.label} readOnly={readOnly} maxLength={NOTE_LIMITS.fieldLabelChars} onChange={event=>update(field.id,{label:event.currentTarget.value})}/>
        <div className="notes-secret__row">
          <input className="notes-secret__value" aria-label={`${field.label||'항목'} 값`} placeholder="값" type={shown?'text':'password'} autoComplete="off" autoCapitalize="none" spellCheck={false} value={field.value} readOnly={readOnly} maxLength={NOTE_LIMITS.fieldValueChars} onChange={event=>update(field.id,{value:event.currentTarget.value})}/>
          <IconButton label={shown?'값 가리기':'값 보기'} icon={shown?EyeSlashIcon:EyeIcon} active={shown} onClick={()=>setRevealed(shown?null:field.id)}/>
          <IconButton label="값 복사" icon={ClipboardDocumentIcon} disabled={!field.value} onClick={()=>void copy(field)}/>
          {!readOnly&&<IconButton label="항목 삭제" icon={XMarkIcon} onClick={()=>onChange({fields:fields.filter(entry=>entry.id!==field.id)})}/>}
        </div>
      </li>;})}
    </ul>
    <p className="notes-secret__copied" role="status">{copyError||(copied?'복사했습니다 · 30초 뒤 클립보드에서 지웁니다':'')}</p>
    {!readOnly&&<button type="button" className="notes-checklist__add" disabled={fields.length>=NOTE_LIMITS.fields} onClick={add}><PlusIcon aria-hidden="true"/>항목 추가</button>}
    <textarea className="notes-secret__memo" aria-label="암호 메모 본문" placeholder="메모" value={memo} readOnly={readOnly} spellCheck={false} onChange={event=>onChange({memo:event.target.value})}/>
  </div>;
}
