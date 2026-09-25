import { listen } from "@tauri-apps/api/event";
import { useEffect } from "react";
import { invoke, isTauri } from "@tauri-apps/api/core";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { message } from "@tauri-apps/plugin-dialog";
import { flushNotes, hasUnsavedNotes, lockAllSecrets } from "./store";

/** Remains mounted when the user leaves Notes with a local write pending. */
export function useNotesCloseGuard(){
  useEffect(()=>{
    const guard=(event:BeforeUnloadEvent)=>{if(hasUnsavedNotes()){event.preventDefault();event.returnValue="";}};
    window.addEventListener("beforeunload",guard);
    let disposed=false;let unlisten:(()=>void)|undefined;let stopQuit:(()=>void)|undefined;let closing=false;
    if(isTauri()) void listen("workload://quit-requested", async () => {
      if (closing) return; closing = true;
      try {
        if (!hasUnsavedNotes() || await flushNotes()) await invoke("workload_quit");
        else await message("PC에 아직 저장하지 못한 메모가 있습니다. 메모를 저장한 뒤 종료해 주세요.", { title: "메모 저장 확인", kind: "warning" });
      } finally { closing = false; }
    }).then(stop => { if (disposed) stop(); else stopQuit = stop; });
    // Always prevent: an unprevented close-requested listener destroys the window, which
    // would bypass hiding to the tray. Rust decides between tray and quit.
    if(isTauri())void getCurrentWindow().onCloseRequested(async event=>{
      event.preventDefault();if(closing)return;closing=true;
      try{
        if(hasUnsavedNotes()&&!await flushNotes()){
          await message("PC에 아직 저장하지 못한 메모가 있습니다. 메모 화면에서 내용을 복사하거나 저장을 다시 시도해 주세요.",{title:"메모 저장 확인",kind:"warning"});
          return;
        }
        // Hiding the window (to the tray) re-locks secret notes.
        await lockAllSecrets();
        await invoke("workload_close_window");
      }finally{closing=false;}
    }).then(stop=>{if(disposed)stop();else unlisten=stop;});
    return()=>{disposed=true;unlisten?.();stopQuit?.();window.removeEventListener("beforeunload",guard);};
  },[]);
}
