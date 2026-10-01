import {useCallback,useEffect,useRef,useState} from 'react';
import type {MangaFrequentIndex,MangaIndexIdentity} from '../src/library/types';
import type {BookmarkAuthority} from './bookmarkOutbox';
import type {CatalogQuery} from './catalogModel';
import {api,errorText} from './transport';
import {outboxConnection} from './outboxConnection';
import {onNetworkRestored} from './deviceSignals';
import {useVisibleInterval} from './useVisibleInterval';
import {adoptPins,flushPins,INDEX_PATH,pendingPins,queuePin,visiblePins,type PinSnapshot} from './mangaIndexPins';

export function useMangaIndex({active,open,authority,query,revision}:{active:boolean;open:boolean;authority:BookmarkAuthority|null;query:CatalogQuery;revision:unknown}){
  const [frequent,setFrequent]=useState<MangaFrequentIndex|null>(null),[pins,setPins]=useState<Array<MangaIndexIdentity&{pending:boolean}>>([]);
  const [available,setAvailable]=useState(false),[message,setMessage]=useState(''),[pending,setPending]=useState(0);
  const request=useRef(0),owner=useRef(authority),mounted=useRef(true);owner.current=authority;
  const connection=outboxConnection();
  const identity=JSON.stringify([connection,authority?.libraryId,authority?.epoch]);
  const params=new URLSearchParams({language:query.language,revealBlocked:String(query.revealBlocked)});
  if(query.categories!==null)params.set('categories',JSON.stringify(query.categories));
  if(query.excludedTags.length)params.set('excludedTags',JSON.stringify(query.excludedTags));
  const frequentPath=`${INDEX_PATH}/frequent?${params}`;
  useEffect(()=>{mounted.current=true;return()=>{mounted.current=false;request.current++;};},[]);
  const refreshPins=()=>{if(owner.current){setPins(visiblePins(owner.current));setPending(pendingPins(owner.current));}};
  const flush=useCallback(async()=>{
    const current=owner.current;if(!current||!active)return;
    const requestOwner=JSON.stringify([outboxConnection(),current.libraryId,current.epoch]);
    try{await flushPins(current);if(mounted.current&&requestOwner===JSON.stringify([outboxConnection(),owner.current?.libraryId,owner.current?.epoch]))setMessage('');}
    catch(error){if(mounted.current&&requestOwner===JSON.stringify([outboxConnection(),owner.current?.libraryId,owner.current?.epoch]))setMessage(`${pendingPins(current)?'고정 저장 대기':'고정 목록 확인 실패'} · ${errorText(error)}`);}
    finally{if(mounted.current&&requestOwner===JSON.stringify([outboxConnection(),owner.current?.libraryId,owner.current?.epoch]))refreshPins();}
  },[active,identity]);
  const load=useCallback(async()=>{
    const current=owner.current;if(!current||!active||!open){setAvailable(false);return;}
    const sequence=++request.current;
    try{
      const [index,snapshot]=await Promise.all([api<MangaFrequentIndex&{ready:boolean}>(frequentPath,undefined,undefined,'GET',false,connection??undefined),api<PinSnapshot>(`${INDEX_PATH}/pins?libraryId=${current.libraryId}&epoch=${current.epoch}`,undefined,undefined,'GET',true,connection??undefined)]);
      if(!mounted.current||sequence!==request.current)return;
      if(!index.ready){setAvailable(false);return;}
      adoptPins(current,snapshot,connection);setFrequent(index);refreshPins();setAvailable(true);
    }catch{if(mounted.current&&sequence===request.current)setAvailable(false);}
  },[active,open,frequentPath,identity]);
  useEffect(()=>{request.current++;setAvailable(false);setMessage('');refreshPins();void flush();},[identity,flush]);
  useEffect(()=>{void load();return()=>{request.current++;};},[load,revision]);
  useEffect(()=>onNetworkRestored(()=>{if(active){void flush();void load();}}),[active,flush,load]);
  useVisibleInterval(()=>{void flush();if(open)void load();},active&&authority?30_000:null);
  function togglePin(row:MangaIndexIdentity){
    const current=owner.current;if(!current)return;
    try{queuePin(current,row,!visiblePins(current).some(pin=>pin.kind===row.kind&&pin.namespace===row.namespace&&pin.value===row.value));request.current++;refreshPins();setMessage('');void flush();}
    catch(error){setMessage(errorText(error));}
  }
  return {frequent,pins,available,message,pending,togglePin};
}
