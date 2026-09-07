import { useEffect } from "react";
import { isTauri } from "@tauri-apps/api/core";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { message } from "@tauri-apps/plugin-dialog";
import { flushNotes, hasUnsavedNotes } from "./store";

/** Remains mounted when the user leaves Notes with a local write pending. */
export function useNotesCloseGuard(){
  useEffect(()=>{
    const guard=(event:BeforeUnloadEvent)=>{if(hasUnsavedNotes()){event.preventDefault();event.returnValue="";}};
    window.addEventListener("beforeunload",guard);
    let disposed=false;let unlisten:(()=>void)|undefined;let closing=false;
    if(isTauri())void getCurrentWindow().onCloseRequested(async event=>{
      if(!hasUnsavedNotes())return;
      event.preventDefault();if(closing)return;closing=true;
      try{
        if(await flushNotes())await getCurrentWindow().close();
        else await message("PC에 아직 저장하지 못한 메모가 있습니다. 메모 화면에서 내용을 복사하거나 저장을 다시 시도해 주세요.",{title:"메모 저장 확인",kind:"warning"});
      }finally{closing=false;}
    }).then(stop=>{if(disposed)stop();else unlisten=stop;});
    return()=>{disposed=true;unlisten?.();window.removeEventListener("beforeunload",guard);};
  },[]);
}
