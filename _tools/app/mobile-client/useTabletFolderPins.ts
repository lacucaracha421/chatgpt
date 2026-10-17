import {useCallback,useEffect,useMemo,useRef,useState} from 'react';
import {FOLDER_PINS_SIGNAL,addFolderPins,loadFolderPins,removeFolderPins} from './folderPins';
import {errorText} from './transport';
import {useSyncSignal} from './syncSignals';

const NONE:string[]=[];

/**
 * The shared folder pins as the tablet shows them (고정): read when the connection is ready, read
 * again when the server's `folderPins` signal moves or the app resumes, and edited one id at a
 * time. A pin or unpin shows at once and is put back if the server refuses; `toggle` answers with
 * the failure text, or an empty string when it worked.
 */
export function useTabletFolderPins(enabled:boolean,scope:string){
  const [ids,setIds]=useState<string[]>(NONE);
  const generation=useRef(0);
  const idsRef=useRef(ids);idsRef.current=ids;
  const read=useCallback(()=>{
    const current=++generation.current,controller=new AbortController();
    void loadFolderPins(controller.signal).then(pins=>{if(current===generation.current)setIds(pins.pinnedIds);},()=>{/* A server without pins keeps the list empty. */});
    return controller;
  },[]);
  useEffect(()=>{
    if(!enabled){generation.current++;setIds(NONE);return;}
    const controller=read();
    const resume=()=>{read();};
    window.addEventListener('lakomics-resume',resume);
    return()=>{generation.current++;controller.abort();window.removeEventListener('lakomics-resume',resume);};
  },[enabled,scope,read]);
  useSyncSignal(FOLDER_PINS_SIGNAL,()=>{read();},enabled);
  const toggle=useCallback(async(id:string):Promise<string>=>{
    const pinned=idsRef.current.includes(id),before=idsRef.current;
    // The edit decides the list; an older read still in flight must not undo it.
    generation.current++;
    setIds(pinned?before.filter(item=>item!==id):[...before,id]);
    try {
      const reply=await (pinned?removeFolderPins([id]):addFolderPins([id]));
      generation.current++;
      setIds(reply.pinnedIds);
      return '';
    } catch(reason) {
      generation.current++;
      setIds(before);
      return errorText(reason)||(pinned?'고정을 풀지 못했습니다.':'폴더를 고정하지 못했습니다.');
    }
  },[]);
  return useMemo(()=>({ids,toggle}),[ids,toggle]);
}
