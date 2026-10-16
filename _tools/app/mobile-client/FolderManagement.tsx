import {useEffect,useRef,useState} from 'react';
import {Button,Field,TextInput} from './ui';
import {BottomSheet} from './BottomSheet';
import {BusyLabel} from '../src/shared/ui/BusyLabel';
import {FOLDER_NAME_LIMIT,folderCommand,folderErrorText,readFolderSnapshot,siblingNameTaken,type AuthorityFolder,type FolderAuthority} from './folderCommands';
import type {Classification} from './types';
import './folderManagement.css';

export type FolderChange = {type:'create'|'rename'; folder:AuthorityFolder};
/** The PC refuses to rename its protected 오리지널 root, so the tablet does not offer it. */
export const isOriginalsRoot=(folder:Pick<Classification,'id'|'name'|'parent_id'>)=>folder.parent_id===null&&(folder.id==='lakomics-originals'||folder.name==='오리지널');

/**
 * Create and rename a folder from the tablet (user decision 2026-10-10). Move and delete stay
 * with the PC, whose character-series rule they depend on, so there is no control for them.
 *
 * A child folder is a tag, as on the PC. The server
 * checks every rule again; the checks here only spare a round trip. An attempt keeps its
 * operation id until the name or target changes, so retrying after a lost reply applies the
 * command once rather than twice.
 */
export function FolderManagement({authority,folders,folder,onClose,onChanged}:{authority:FolderAuthority;folders:readonly Classification[];folder:Classification;onClose():void;onChanged(change:FolderChange):void}) {
  const [mode,setMode]=useState<'menu'|'create'|'rename'>('menu');
  const [name,setName]=useState('');
  const [snapshot,setSnapshot]=useState<AuthorityFolder[]|null>(null),[busy,setBusy]=useState(false),[error,setError]=useState('');
  const lock=useRef(false),attempt=useRef<{key:string;operationId:string;folderId:string}|null>(null);
  const read=()=>{setError('');setSnapshot(null);return readFolderSnapshot(authority).then(setSnapshot,reason=>setError(folderErrorText(reason)));};
  useEffect(()=>{
    let live=true;const controller=new AbortController();
    void readFolderSnapshot(authority,controller.signal).then(value=>{if(live)setSnapshot(value);},reason=>{if(live&&!controller.signal.aborted)setError(folderErrorText(reason));});
    return()=>{live=false;controller.abort();};
  },[authority.libraryId,authority.epoch,folder.id]);
  const current=snapshot?.find(item=>item.id===folder.id);
  const target=folder.id;
  const trimmed=name.trim();
  const problem=!trimmed?'':trimmed.length>FOLDER_NAME_LIMIT?'폴더 이름이 너무 깁니다.'
    :mode==='create'&&siblingNameTaken(folders,folder.id,trimmed)?'같은 위치에 같은 이름의 폴더가 있습니다.'
    :mode==='rename'&&trimmed!==folder.name&&siblingNameTaken(folders,folder.parent_id,trimmed,folder.id)?'같은 위치에 같은 이름의 폴더가 있습니다.':'';
  const close=()=>{if(!lock.current)onClose();};
  const save=async()=>{
    if(lock.current||!trimmed||problem||mode==='menu')return;
    if(mode==='rename'&&(!current||trimmed===current.name))return;
    lock.current=true;setBusy(true);setError('');
    try {
      const key=`${mode}:${target}:${trimmed}:${current?.entityRevision??0}`;
      if(attempt.current?.key!==key)attempt.current={key,operationId:crypto.randomUUID(),folderId:mode==='create'?crypto.randomUUID():folder.id};
      const {operationId,folderId}=attempt.current;
      const fields=mode==='create'
        ?{classificationId:folderId,kind:'tag',name:trimmed,parentId:folder.id,iconKey:null,colorKey:null}
        :{classificationId:folderId,name:trimmed,expectedRevision:current!.entityRevision};
      const reply=await folderCommand(authority,operationId,mode==='create'?'createClassification':'renameClassification',fields);
      if(!reply.classification||reply.classification.id!==folderId)throw new Error('변경 결과를 확인하지 못했습니다. 폴더 목록을 다시 확인해 주세요.');
      onChanged({type:mode,folder:reply.classification});
      onClose();
    } catch(reason) {setError(folderErrorText(reason));}
    finally {lock.current=false;setBusy(false);}
  };
  const title={menu:'폴더 관리',create:'하위 폴더 만들기',rename:'이름 바꾸기'}[mode];
  const originals=isOriginalsRoot(folder);
  const checking=!snapshot&&!error;
  return <BottomSheet title={title} onClose={close}><div className="folder-management">
    <BusyLabel delay={400} busy={checking}>폴더 정보 확인 중</BusyLabel>
    {error&&<p role="alert" className="error-message">{error}{!snapshot&&<Button variant="ghost" disabled={busy} onClick={()=>void read()}>다시 시도</Button>}</p>}
    {snapshot&&!current&&<p role="alert">이 폴더는 삭제되었거나 옮겨졌습니다. 목록을 새로 고쳐 주세요.</p>}
    {mode==='menu'?<div className="folder-management-actions">
      <Button disabled={!current||originals} onClick={()=>{setName(folder.name);setMode('rename');}}>이름 바꾸기</Button>
      <Button disabled={!current} onClick={()=>{setName('새 폴더');setMode('create');}}>하위 폴더 만들기</Button>
      {originals&&<p className="hint">오리지널 기본 영역의 이름은 유지됩니다.</p>}
      <p className="hint">폴더 이동과 삭제는 PC에서 할 수 있습니다.</p>
    </div>:<>
      <Field label="폴더 이름"><TextInput value={name} disabled={busy} maxLength={FOLDER_NAME_LIMIT+20} onChange={event=>{setName(event.target.value);setError('');}} autoFocus/></Field>
      {problem&&<p className="hint" role="status">{problem}</p>}
      <div className="ui-dialog__actions"><Button disabled={busy} onClick={close}>취소</Button><Button variant="primary" disabled={busy||!trimmed||!!problem||(mode==='rename'&&(!current||trimmed===current.name))} onClick={()=>void save()}><BusyLabel delay={400} busy={busy} idle={mode==='create'?'만들기':'저장'}>저장 중</BusyLabel></Button></div>
    </>}
  </div></BottomSheet>;
}
