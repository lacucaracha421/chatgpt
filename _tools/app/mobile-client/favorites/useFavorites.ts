import {useCallback,useEffect,useRef,useState} from 'react';
import type {FavoriteCharacters,FavoriteCommand} from '../../src/library/types';
import {useSyncSignal} from '../syncSignals';
import {errorText} from '../transport';
import {changeFavorites,FAVORITES_SIGNAL,loadFavorites} from './store';

/** Like folder pins, commands merge on the server; a failed save keeps the confirmed screen. */
export function useFavorites(enabled:boolean) {
  const [document,setDocument]=useState<FavoriteCharacters|null>(null);
  const [busy,setBusy]=useState(false),[error,setError]=useState('');
  const writing=useRef(false),alive=useRef(true),generation=useRef(0);
  useEffect(()=>{alive.current=true;return()=>{alive.current=false;generation.current++;};},[]);
  const adopt=useCallback((reply:FavoriteCharacters)=>{
    setDocument(before=>!before||reply.revision>=before.revision?reply:before);
  },[]);
  const refresh=useCallback(()=>{
    const at=++generation.current,controller=new AbortController();
    setBusy(true);
    void loadFavorites(controller.signal).then(reply=>{
      if(alive.current&&at===generation.current){adopt(reply);setError('');}
    },reason=>{if(alive.current&&at===generation.current)setError(errorText(reason));})
      .finally(()=>{if(alive.current&&at===generation.current&&!writing.current)setBusy(false);});
    return controller;
  },[adopt]);
  useEffect(()=>{
    if(!enabled)return;
    const controller=refresh();
    const resume=()=>{refresh();};window.addEventListener('lakomics-resume',resume);
    return()=>{controller.abort();generation.current++;window.removeEventListener('lakomics-resume',resume);};
  },[enabled,refresh]);
  useSyncSignal(FAVORITES_SIGNAL,()=>{refresh();},enabled);
  const change=useCallback(async(command:FavoriteCommand):Promise<boolean>=>{
    if(writing.current)return false;
    writing.current=true;generation.current++;setBusy(true);setError('');
    try {
      const reply=await changeFavorites([command]);
      if(alive.current){adopt(reply);setError('');}
      return true;
    } catch(reason) {
      if(alive.current)setError(errorText(reason)||'변경 내용을 저장하지 못했습니다. 다시 시도해 주세요.');
      return false;
    } finally {writing.current=false;if(alive.current)setBusy(false);}
  },[adopt]);
  return {document,busy,error,change,refresh};
}
