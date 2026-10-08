import { useDelayedBusy } from "../src/shared/useDelayedBusy";
import { BusyLabel } from "../src/shared/ui/BusyLabel";
import {usePrivacyMode} from './privacyMode';
import {useCallback, useEffect, useMemo, useRef, useState, type MutableRefObject} from 'react';
import {ArrowLeftIcon, FolderIcon, InboxIcon, LockClosedIcon} from '@heroicons/react/24/outline';
import {Button, CountBadge, Dialog, DialogDescription, EmptyState, IconButton} from './ui';
import {FolderShelf} from './FolderCards';
import {errorText, native} from './transport';
import {Gallery, type GalleryVaultSource} from './Gallery';
import {Viewer, type ViewerVaultSource} from './Viewer';
import {FilterChips, type FilterGroup} from './FilterChips';
import {EMPTY_FILTERS} from './assetFilters';
import type {Asset, AssetFiltersValue} from './types';
import './PrivateVault.css';

type Item = {id:string; title:string; kind:'image'|'video'; url:string; thumbnail:string|null; width?:number|null; height?:number|null; durationMs?:number|null; folderId?:string|null};
/** PC user folders: browsed here, created and filled only on the PC. */
type Folder = {id:string; name:string; parentId:string|null};
export type VaultState = {epoch:number; selected:boolean; present:boolean; unlocked:boolean; message:string; items:Item[]; folders?:Folder[]};
/** Where the grid looks, as on the PC: everything, items in no folder, or a folder with its subfolders. */
type Scope = {kind:'all'} | {kind:'unfiled'} | {kind:'folder'; id:string};
const ALL:Scope = {kind:'all'};
const initial:VaultState = {epoch:-1,selected:false,present:false,unlocked:false,message:'',items:[]};

const ignore=()=>{};
/**
 * All state is transient. Never use the library media client, tickets, or JS storage.
 * The grid and viewer are the library's own components in their vault mode.
 */
export function PrivateVault({onClose,backRef,density=1}:{onClose():void;backRef:MutableRefObject<(()=>boolean)|null>;density?:number}) {
  const [privacy]=usePrivacyMode();
  const [state,setState]=useState(initial),[ready,setReady]=useState(false),[busy,setBusy]=useState(false);
  const [secret,setSecret]=useState(''),[recovery,setRecovery]=useState(false),[error,setError]=useState('');
  const [selected,setSelected]=useState<number|null>(null);
  // Kind filter and thumbnail shapes live in memory only and are dropped on every lock.
  const [filters,setFilters]=useState<AssetFiltersValue>(EMPTY_FILTERS),[filtersOpen,setFiltersOpen]=useState<FilterGroup|null>(null);
  const [ratios,setRatios]=useState<Record<string,number>>({});
  const [scope,setScope]=useState<Scope>(ALL);
  const epoch=useRef(-1),mounted=useRef(true),selection=useRef(selected),sheet=useRef(filtersOpen),attempt=useRef<AbortController|null>(null),place=useRef<Scope>(scope),folderList=useRef<Folder[]>([]);
  const lifecycle=useRef(0);
  selection.current=selected;sheet.current=filtersOpen;place.current=scope;folderList.current=state.folders??[];
  const apply=(next:VaultState)=>{
    if(!mounted.current || next.epoch<epoch.current)return;
    epoch.current=next.epoch;setState(next);
    if(!next.unlocked){setSelected(null);setSecret('');setFilters(EMPTY_FILTERS);setFiltersOpen(null);setRatios({});setScope(ALL);}
    else setScope(current=>current.kind==='folder'&&!(next.folders??[]).some(folder=>folder.id===current.id)?ALL:current);
  };
  const refresh=()=>{
    const turn=++lifecycle.current;setReady(false);
    void native<VaultState>('vaultState').then(next=>{if(mounted.current && turn===lifecycle.current){apply(next);setReady(true);}}).catch(reason=>{if(mounted.current && turn===lifecycle.current)setError(errorText(reason));});
  };
  useEffect(()=>{
    mounted.current=true;
    const turn=++lifecycle.current;
    void native<VaultState>('vaultShow',{visible:true}).then(next=>{if(mounted.current && turn===lifecycle.current){apply(next);setReady(true);}}).catch(reason=>{if(mounted.current)setError(errorText(reason));});
    const changed=(event:Event)=>apply((event as CustomEvent<VaultState>).detail);
    const pause=()=>{lifecycle.current++;setReady(false);setSecret('');setSelected(null);setState(value=>({...value,items:[]}));};
    window.addEventListener('lakomics-vault',changed);
    window.addEventListener('lakomics-pause',pause);
    window.addEventListener('lakomics-resume',refresh);
    backRef.current=()=>{
      if(selection.current!==null){setSelected(null);return true;}
      if(sheet.current!==null){setFiltersOpen(null);return true;}
      if(place.current.kind!=='all'){setScope(parentScope(place.current,folderList.current));return true;}
      return false;
    };
    return ()=>{
      mounted.current=false;lifecycle.current++;attempt.current?.abort();backRef.current=null;
      window.removeEventListener('lakomics-vault',changed);window.removeEventListener('lakomics-pause',pause);window.removeEventListener('lakomics-resume',refresh);
      void native('vaultLock').catch(()=>{});
      void native('vaultShow',{visible:false}).catch(()=>{});
    };
  },[backRef]);
  const lock=()=>{
    attempt.current?.abort();setSelected(null);setSecret('');setState(value=>({...value,unlocked:false,items:[]}));
    void native<VaultState>('vaultLock').then(apply).catch(reason=>setError(errorText(reason)));
  };
  const unlock=()=>{
    const controller=new AbortController();attempt.current=controller;
    const value=secret;setSecret('');setBusy(true);setError('');
    void native<VaultState>('vaultUnlock',{secret:value,recovery},controller.signal).then(apply).catch(reason=>{if(mounted.current)setError(errorText(reason));}).finally(()=>{if(mounted.current)setBusy(false);});
  };
  const byId=useMemo(()=>new Map(state.items.map(item=>[item.id,item])),[state.items]);
  // The viewer swipes through exactly the filtered list the grid shows.
  const folders=useMemo(()=>state.folders??[],[state.folders]);
  const inScope=useMemo(()=>scopeFilter(scope,folders),[scope,folders]);
  const assets=useMemo<Asset[]>(()=>state.items
    .filter(item=>inScope(item)&&(filters.media==='all'||(filters.media==='videos')===(item.kind==='video')))
    .map(item=>({id:item.id,kind:item.kind,width:item.width??null,height:item.height??null,duration_ms:item.durationMs??null,preview:item.thumbnail??undefined,thumbnail_available:!!item.thumbnail,ratio:ratios[item.id]})),[state.items,inScope,filters.media,ratios]);
  const currentFolder=scope.kind==='folder'?folders.find(folder=>folder.id===scope.id):undefined;
  const changeScope=(next:Scope)=>{setSelected(null);setScope(next);};
  const gallery=useMemo<GalleryVaultSource>(()=>({label:asset=>`${byId.get(asset.id)?.title??''} · ${asset.kind==='video'?'영상':'이미지'}`}),[byId]);
  const viewer=useMemo<ViewerVaultSource>(()=>({original:asset=>byId.get(asset.id)?.url??'',label:asset=>byId.get(asset.id)?.title??''}),[byId]);
  const shaped=useCallback((asset:Asset)=>{if(asset.ratio)setRatios(value=>({...value,[asset.id]:asset.ratio!}));},[]);
  const close=()=>{if(selected!==null)setSelected(null);else if(scope.kind!=='all')setScope(parentScope(scope,folders));else onClose();};
  const open=selected!==null&&selected<assets.length;
  const showChecking = useDelayedBusy(!ready && !error);
  return <Dialog open layer title="비밀 보관함" variant="fullscreen" onClose={close}>
    <DialogDescription className="sr-only">USB에 있는 비밀 보관함을 열어 이미지와 영상을 감상합니다.</DialogDescription>
    <section className="private-vault" onContextMenu={event=>event.preventDefault()}>
      <header className="vault-header">
        <IconButton label={scope.kind==='all'?'비밀 보관함 닫기':'상위로'} icon={ArrowLeftIcon} onClick={scope.kind==='all'?onClose:()=>changeScope(parentScope(scope,folders))}/>
        <h2>{scope.kind==='unfiled'?'미분류':currentFolder?.name??'비밀 보관함'}</h2>
        {state.unlocked && <Button onClick={lock}><LockClosedIcon/>잠그기</Button>}
      </header>
      {error && <p className="error-message" role="alert">{error}</p>}
      {!ready || showChecking ? (showChecking||error ? <EmptyState role="status" title={error?'보관함을 확인하지 못했습니다':'보관함 확인 중'} action={error?<Button onClick={refresh}>다시 시도</Button>:undefined}/> : <div role="status"/>) : !state.unlocked ?
        <div className="vault-locked">
          <LockClosedIcon aria-hidden="true"/>
          <h3>{state.present?'비밀 보관함이 잠겨 있습니다':'USB를 연결해 주세요'}</h3>
          {state.message && <p role="status">{state.message}</p>}
          {state.present ? <form autoComplete="off" onSubmit={event=>{event.preventDefault();unlock();}}>
            <div className="vault-secret-kind" role="group" aria-label="잠금 해제 방법">
              <Button type="button" aria-pressed={!recovery} disabled={busy} onClick={()=>{setRecovery(false);setSecret('');}}>비밀번호</Button>
              <Button type="button" aria-pressed={recovery} disabled={busy} onClick={()=>{setRecovery(true);setSecret('');}}>복구 키</Button>
            </div>
            <label className="field">{recovery?'복구 키':'비밀번호'}<input type="password" autoComplete="off" autoCapitalize="none" autoCorrect="off" spellCheck={false} required disabled={busy} value={secret} onChange={event=>setSecret(event.target.value)}/></label>
            <Button variant="primary" type="submit" disabled={busy||!secret}><BusyLabel busy={!!(busy)} idle={'보관함 열기'}>여는 중…</BusyLabel></Button>
          </form> : <>
            <p>USB-C로 연결한 USB의 최상위 폴더를 선택해 주세요.</p>
            {state.selected && <Button onClick={refresh}>USB 다시 확인</Button>}
          </>}
          <Button variant="ghost" disabled={busy} onClick={()=>{setError('');void native<VaultState>('vaultPick').then(apply).catch(reason=>setError(errorText(reason)));}}>{state.selected?'다른 USB 폴더 선택':'USB 폴더 선택'}</Button>
        </div> : <>
          <Gallery privacy={privacy} items={assets} vault={gallery} density={density} identity={`vault:${state.epoch}:${filters.media}:${scopeKey(scope)}`} restoreScroll={0} onScroll={ignore} onOpen={setSelected} onReady={shaped} onNearEnd={ignore} paused={open} scrubberHidden={filtersOpen!==null}
            intro={<>
              {scope.kind!=='unfiled'&&<VaultFolderShelf folders={folders} items={state.items} parentId={currentFolder?.id??null} privacy={privacy} onOpen={changeScope}/>}
              <FilterChips value={filters} onChange={value=>{setFilters(value);setFiltersOpen(null);}} open={filtersOpen} onOpen={setFiltersOpen} aspect={false} duration={false}/>
              {assets.length===0&&<EmptyState title={state.items.length?'조건에 맞는 항목이 없습니다':'보관함이 비어 있습니다'}/>}
            </>}/>
          {open&&<Viewer items={assets} index={selected!} onIndex={setSelected} onClose={()=>setSelected(null)} vault={viewer}/>}
        </>}
    </section>
  </Dialog>;
}

const scopeKey=(scope:Scope)=>scope.kind==='folder'?`folder:${scope.id}`:scope.kind;

/** One level up: a folder's parent folder, or 전체 from a top-level folder and from 미분류. */
function parentScope(scope:Scope,folders:Folder[]):Scope {
  if(scope.kind!=='folder')return ALL;
  const parentId=folders.find(folder=>folder.id===scope.id)?.parentId;
  return parentId?{kind:'folder',id:parentId}:ALL;
}

/** A folder shows its own items and those of its subfolders, as on the PC. */
function scopeFilter(scope:Scope,folders:Folder[]):(item:Item)=>boolean {
  if(scope.kind==='all')return ()=>true;
  if(scope.kind==='unfiled')return item=>!item.folderId;
  const inside=new Set([scope.id]);
  for(let grew=true;grew;){
    grew=false;
    for(const folder of folders)if(folder.parentId&&inside.has(folder.parentId)&&!inside.has(folder.id)){inside.add(folder.id);grew=true;}
  }
  return item=>!!item.folderId&&inside.has(item.folderId);
}

/** The PC's folders as the tablet's folder shelf: 미분류 first at the top level, then the subfolders. */
function VaultFolderShelf({folders,items,parentId,privacy,onOpen}:{folders:Folder[];items:Item[];parentId:string|null;privacy:boolean;onOpen(scope:Scope):void}) {
  if(folders.length===0)return null;
  const children=folders.filter(folder=>folder.parentId===parentId).sort((a,b)=>a.name.localeCompare(b.name,'ko'));
  const card=(key:string,name:string,scope:Scope,Icon:typeof FolderIcon)=>{
    const inside=items.filter(scopeFilter(scope,folders));
    const cover=privacy?undefined:inside.find(item=>item.thumbnail)?.thumbnail;
    return <article key={key} className="folder-shelf__card">
      <button type="button" className="folder-shelf__card-open" onClick={()=>onOpen(scope)} aria-label={`${name}, ${inside.length}개`}>
        <span className="folder-thumbnail"><span className="home-cover-group single">{cover&&<img className="home-cover" src={cover} alt="" draggable={false}/>}</span><CountBadge variant="scrim" className="folder-thumbnail__count" value={inside.length} unit="개"/></span>
        <strong><span className="folder-shelf__icon"><Icon aria-hidden="true"/></span><span className="folder-shelf__name">{name}</span></strong>
      </button>
    </article>;
  };
  const cards=[
    ...(parentId===null?[card('unfiled','미분류',{kind:'unfiled'},InboxIcon)]:[]),
    ...children.map(folder=>card(folder.id,folder.name,{kind:'folder',id:folder.id},FolderIcon)),
  ];
  if(parentId!==null&&children.length===0)return null;
  return <FolderShelf label={parentId===null?'폴더':'하위 폴더'} cards={cards}/>;
}
