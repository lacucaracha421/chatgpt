import {useCallback, useEffect, useMemo, useRef, useState, type MutableRefObject} from 'react';
import {ArrowLeftIcon, LockClosedIcon} from '@heroicons/react/24/outline';
import {Button, Dialog, DialogDescription, IconButton} from './ui';
import {errorText, native} from './transport';
import {Gallery, type GalleryVaultSource} from './Gallery';
import {Viewer, type ViewerVaultSource} from './Viewer';
import {FilterChips, type FilterGroup} from './FilterChips';
import {EMPTY_FILTERS} from './assetFilters';
import type {Asset, AssetFiltersValue} from './types';
import './PrivateVault.css';

type Item = {id:string; title:string; kind:'image'|'video'; url:string; thumbnail:string|null; width?:number|null; height?:number|null};
export type VaultState = {epoch:number; selected:boolean; present:boolean; unlocked:boolean; message:string; items:Item[]};
const initial:VaultState = {epoch:-1,selected:false,present:false,unlocked:false,message:'',items:[]};

const ignore=()=>{};
/**
 * All state is transient. Never use the library media client, tickets, or JS storage.
 * The grid and viewer are the library's own components in their vault mode.
 */
export function PrivateVault({onClose,backRef,density=1}:{onClose():void;backRef:MutableRefObject<(()=>boolean)|null>;density?:number}) {
  const [state,setState]=useState(initial),[ready,setReady]=useState(false),[busy,setBusy]=useState(false);
  const [secret,setSecret]=useState(''),[recovery,setRecovery]=useState(false),[error,setError]=useState('');
  const [selected,setSelected]=useState<number|null>(null);
  // Kind filter and thumbnail shapes live in memory only and are dropped on every lock.
  const [filters,setFilters]=useState<AssetFiltersValue>(EMPTY_FILTERS),[filtersOpen,setFiltersOpen]=useState<FilterGroup|null>(null);
  const [ratios,setRatios]=useState<Record<string,number>>({});
  const epoch=useRef(-1),mounted=useRef(true),selection=useRef(selected),sheet=useRef(filtersOpen),attempt=useRef<AbortController|null>(null);
  const lifecycle=useRef(0);
  selection.current=selected;sheet.current=filtersOpen;
  const apply=(next:VaultState)=>{
    if(!mounted.current || next.epoch<epoch.current)return;
    epoch.current=next.epoch;setState(next);
    if(!next.unlocked){setSelected(null);setSecret('');setFilters(EMPTY_FILTERS);setFiltersOpen(null);setRatios({});}
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
  const assets=useMemo<Asset[]>(()=>state.items
    .filter(item=>filters.media==='all'||(filters.media==='videos')===(item.kind==='video'))
    .map(item=>({id:item.id,kind:item.kind,width:item.width??null,height:item.height??null,preview:item.thumbnail??undefined,thumbnail_available:!!item.thumbnail,ratio:ratios[item.id]})),[state.items,filters.media,ratios]);
  const gallery=useMemo<GalleryVaultSource>(()=>({label:asset=>`${byId.get(asset.id)?.title??''} · ${asset.kind==='video'?'영상':'이미지'}`}),[byId]);
  const viewer=useMemo<ViewerVaultSource>(()=>({original:asset=>byId.get(asset.id)?.url??'',label:asset=>byId.get(asset.id)?.title??''}),[byId]);
  const shaped=useCallback((asset:Asset)=>{if(asset.ratio)setRatios(value=>({...value,[asset.id]:asset.ratio!}));},[]);
  const close=()=>{if(selected!==null)setSelected(null);else onClose();};
  const open=selected!==null&&selected<assets.length;
  return <Dialog open title="비밀 보관함" variant="fullscreen" onClose={close}>
    <DialogDescription className="sr-only">USB에 있는 비밀 보관함을 열어 이미지와 영상을 감상합니다.</DialogDescription>
    <section className="private-vault" onContextMenu={event=>event.preventDefault()}>
      <header className="vault-header">
        <IconButton label="비밀 보관함 닫기" icon={ArrowLeftIcon} onClick={onClose}/>
        <h2>비밀 보관함</h2>
        {state.unlocked && <Button onClick={lock}><LockClosedIcon/>잠그기</Button>}
      </header>
      {error && <p className="error-message" role="alert">{error}</p>}
      {!ready ? <div className="empty-state"><p>보관함 확인 중…</p>{error&&<Button onClick={refresh}>다시 확인</Button>}</div> : !state.unlocked ?
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
            <Button variant="primary" type="submit" disabled={busy||!secret}>{busy?'여는 중…':'보관함 열기'}</Button>
          </form> : <>
            <p>USB-C로 연결한 USB의 최상위 폴더를 선택해 주세요.</p>
            {state.selected && <Button onClick={refresh}>USB 다시 확인</Button>}
          </>}
          <Button variant="ghost" disabled={busy} onClick={()=>{setError('');void native<VaultState>('vaultPick').then(apply).catch(reason=>setError(errorText(reason)));}}>{state.selected?'다른 USB 폴더 선택':'USB 폴더 선택'}</Button>
        </div> : <>
          <Gallery items={assets} vault={gallery} density={density} identity={`vault:${state.epoch}:${filters.media}`} restoreScroll={0} onScroll={ignore} onOpen={setSelected} onReady={shaped} onNearEnd={ignore} paused={open}
            intro={<>
              <FilterChips value={filters} onChange={value=>{setFilters(value);setFiltersOpen(null);}} open={filtersOpen} onOpen={setFiltersOpen} aspect={false} duration={false}/>
              {assets.length===0&&<div className="empty-state"><p>{state.items.length?'조건에 맞는 항목이 없습니다.':'보관함이 비어 있습니다.'}</p></div>}
            </>}/>
          {open&&<Viewer items={assets} index={selected!} onIndex={setSelected} onClose={()=>setSelected(null)} vault={viewer}/>}
        </>}
    </section>
  </Dialog>;
}
