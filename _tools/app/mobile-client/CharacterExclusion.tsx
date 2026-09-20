import {useEffect,useRef,useState} from 'react';
import {XMarkIcon} from '@heroicons/react/24/outline';
import {Button,Dialog,DialogDescription,IconButton} from './ui';
import {ApiError,api,errorText} from './transport';

/** The exact body sent for one logical exclusion. Every retry sends this unchanged. */
export type ExclusionRequest = {
  version:1;
  libraryId:string;
  operationId:string;
  targetId:string;
  assetId:string;
  revision:string;
};

export type ExclusionReceipt = {
  version:1;
  operationId:string;
  libraryId:string;
  targetId:string;
  assetId:string;
  sequence:number;
  revision:string;
  pendingPc:boolean;
};

/** The four identities one pending operation belongs to. */
export type ExclusionKey = {endpoint:string;libraryId:string;targetId:string;assetId:string};

/**
 * One pending operation, stored per (endpoint, library, target, asset).
 *
 * The key deliberately excludes the revision: a retry must reuse the exact body the user
 * confirmed, even after the publication revision moved on, because the server looks up the
 * operation receipt *before* it compares revisions — a resend of an accepted operation returns
 * its recorded result. Re-deriving the body from newer state would instead present a request
 * the server never accepted.
 *
 * Storage is durability, not a queue: it holds only operations the user already confirmed, so
 * a device without storage cannot send at all rather than send an irreversible write that may
 * be duplicated.
 */
const KEY_PART=(value:string)=>encodeURIComponent(value);
export const exclusionStorageKey=(key:ExclusionKey)=>
  `lakomics.character.exclusion.${KEY_PART(key.endpoint)}.${KEY_PART(key.libraryId)}.${KEY_PART(key.targetId)}.${KEY_PART(key.assetId)}`;

export function readPendingExclusion(key:ExclusionKey):ExclusionRequest|null {
  try{
    const saved=JSON.parse(localStorage.getItem(exclusionStorageKey(key))||'null') as ExclusionRequest|null;
    if(!saved||saved.version!==1)return null;
    if(typeof saved.operationId!=='string'||!/^[a-f0-9-]{36}$/.test(saved.operationId))return null;
    // The stored body must still name this exact pair; a mismatched entry is not reusable.
    if(saved.libraryId!==key.libraryId||saved.targetId!==key.targetId||saved.assetId!==key.assetId)return null;
    if(!/^[a-f0-9]{64}$/.test(saved.revision))return null;
    return saved;
  }catch{return null;}
}

export function writePendingExclusion(key:ExclusionKey,request:ExclusionRequest):boolean {
  try{localStorage.setItem(exclusionStorageKey(key),JSON.stringify(request));return true;}catch{return false;}
}

export function clearPendingExclusion(key:ExclusionKey):void {
  try{localStorage.removeItem(exclusionStorageKey(key));}catch{/* Nothing durable was stored. */}
}

/** The coded rejections that prove nothing was accepted, so retrying the same body cannot help. */
const REFUSED_CODES=new Set(['characterSnapshotChanged','characterReferenceProtected','characterExclusionUnsupported','libraryMismatch']);

/** The server's coded reason, from the rejection body root or its `detail` object. */
function refusalCode(error:unknown):string|null {
  const root=(error as ApiError|undefined)?.details as {code?:unknown;detail?:{code?:unknown}}|undefined;
  const code=root?.detail?.code??root?.code;
  return typeof code==='string'?code:null;
}

function refusalText(error:unknown):string {
  const code=refusalCode(error);
  if(code==='characterReferenceProtected')return '기준 이미지로 쓰이는 자산은 이 캐릭터에서 제외할 수 없습니다.';
  if(code==='characterSnapshotChanged')return '캐릭터 보기가 변경되었습니다. 새로고침한 뒤 다시 시도해 주세요.';
  if(code==='characterExclusionUnsupported')return '서버에 캐릭터 제외 기능이 없습니다. 서버를 업데이트해 주세요.';
  if(code==='libraryMismatch')return '다른 라이브러리에 연결되어 제외를 적용하지 않았습니다.';
  return errorText(error);
}

/** A reply counts only when it names this exact operation with a well-formed receipt. */
export function receiptMatches(receipt:ExclusionReceipt,request:ExclusionRequest):boolean {
  return receipt?.version===1
    && receipt.operationId===request.operationId
    && receipt.libraryId===request.libraryId
    && receipt.targetId===request.targetId
    && receipt.assetId===request.assetId
    && Number.isSafeInteger(receipt.sequence)&&receipt.sequence>0
    && typeof receipt.revision==='string'&&/^[a-f0-9]{64}$/.test(receipt.revision)
    && typeof receipt.pendingPc==='boolean';
}

/**
 * Manual character exclusion for the Asset currently open in a character's gallery.
 *
 * Scope: exclude this Asset from the character the viewer was opened from, after confirming.
 * It moves no file, changes no folder, and never affects another character. Success is claimed
 * only after a matching receipt; every other outcome leaves the asset in place.
 *
 * A confirmed but unanswered operation survives closing, swiping and a revision change, keyed
 * by endpoint/library/target/asset, and a reopened confirmation for that same pair resends the
 * exact stored body. It is retired only on a validated receipt, or on an authoritative coded
 * rejection that proves the operation was not accepted and cannot be retried as-is.
 */
export function CharacterExclusionEditor({request,target,assetLabel,characterName,onClose,onExcluded}:{
  request:ExclusionRequest|null;
  target:ExclusionKey|null;
  assetLabel:string;
  characterName:string;
  onClose():void;
  onExcluded(receipt:ExclusionReceipt):void;
}) {
  const [busy,setBusy]=useState(false);
  const [error,setError]=useState('');
  const owner=useRef<{request:ExclusionRequest|null;key:ExclusionKey|null}>({request,key:target});
  owner.current={request,key:target};
  const alive=useRef(true);
  const send=useRef<AbortController|null>(null);

  // StrictMode runs setup/cleanup/setup, so `alive` is restored on setup rather than only
  // cleared on cleanup — otherwise the second mount would believe it had unmounted.
  useEffect(()=>{
    alive.current=true;
    return()=>{alive.current=false;send.current?.abort();send.current=null;};
  },[]);
  useEffect(()=>{
    // A changed request or target belongs to a new confirmation. Any in-flight send is
    // cancelled and detached, so its settled `finally` cannot touch this one's busy state.
    send.current?.abort();send.current=null;
    setBusy(false);setError('');
  },[request,target?.endpoint,target?.libraryId,target?.targetId,target?.assetId]);

  /**
   * Whether a reply still belongs to the operation this editor started.
   *
   * Endpoint, library, target and asset must all still be the ones that were sent, and the
   * editor must still be mounted. Comparing the request identities is not enough on its own:
   * two endpoints can carry the same ids, so a late reply from the previous endpoint would
   * otherwise be accepted as this one's success.
   */
  const owns=(sent:ExclusionRequest,sentKey:ExclusionKey)=>{
    const current=owner.current;
    return alive.current
      && current.key?.endpoint===sentKey.endpoint
      && current.key.libraryId===sentKey.libraryId
      && current.key.targetId===sentKey.targetId
      && current.key.assetId===sentKey.assetId
      && current.request?.libraryId===sent.libraryId
      && current.request.targetId===sent.targetId
      && current.request.assetId===sent.assetId;
  };

  const confirm=async()=>{
    const current=owner.current.request;
    const currentKey=owner.current.key;
    if(!current||!currentKey||busy||send.current)return;
    setBusy(true);setError('');
    // Reuse the stored operation when this pair already has one; otherwise this confirmation's
    // own composition. Both are written before the send so a lost response is retryable.
    const body:ExclusionRequest=readPendingExclusion(currentKey)??current;
    if(!writePendingExclusion(currentKey,body)){
      setBusy(false);
      setError('이 기기에서 제외 요청을 안전하게 보관할 수 없습니다. 저장 공간을 확인한 뒤 다시 시도해 주세요.');
      return;
    }
    const sentKey={...currentKey};
    const controller=new AbortController();
    send.current=controller;
    try{
      const receipt=await api<ExclusionReceipt>('/v1/library/characters/exclusions',controller.signal,body);
      if(send.current!==controller||owner.current.request!==current||!owns(body,sentKey))return;
      if(!receiptMatches(receipt,body))throw new Error('제외 응답을 확인할 수 없습니다. 다시 시도해 주세요.');
      // Accepted and recorded: only now is the retry identity retired.
      clearPendingExclusion(sentKey);
      onExcluded(receipt);
    }catch(reason){
      if(send.current!==controller||owner.current.request!==current||!owns(body,sentKey))return;
      if(reason instanceof DOMException&&reason.name==='AbortError')return;
      // Each coded rejection is authoritative that nothing was accepted, so the pending
      // operation is retired rather than resent. A stale snapshot needs refreshed context;
      // the others cannot succeed on retry at all.
      if(REFUSED_CODES.has(refusalCode(reason)??''))clearPendingExclusion(sentKey);
      setError(refusalText(reason));
    }finally{
      // Only the send this editor still owns may clear its own busy state.
      if(send.current===controller){send.current=null;if(owns(body,sentKey))setBusy(false);}
    }
  };

  return <Dialog open={!!request} title={`${characterName}에서 제외`} onClose={onClose}>
    <DialogDescription className="sr-only">{assetLabel}을(를) {characterName}에서 제외합니다. 파일과 폴더는 그대로 남고 다른 캐릭터에는 영향이 없습니다. 확인을 눌러야 서버에 적용됩니다.</DialogDescription>
    <div className="dialog-header"><span>{characterName}에서 제외</span><IconButton label="제외 닫기" icon={XMarkIcon} onClick={onClose}/></div>
    <p className="hint">파일은 삭제되지 않고 폴더도 그대로 남습니다. 이 캐릭터에서만 제외되고 다른 캐릭터에는 영향이 없습니다.</p>
    {error&&<p className="error-message" role="alert">{error}</p>}
    <div className="dialog-actions">
      <Button variant="ghost" disabled={busy} onClick={onClose}>취소</Button>
      <Button variant="primary" disabled={busy||!request} onClick={()=>void confirm()}>{busy?'제외 적용 중':'제외'}</Button>
    </div>
  </Dialog>;
}
