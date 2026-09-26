import { nativeWorkload } from "./workloadProfile";
import { listen } from "@tauri-apps/api/event";
import {useEffect} from 'react';
import type {LibraryGateway} from '../library/types';
import {ALBUM_AUTHORITY_CHANGED_EVENT} from './useAlbumAuthoritySync';
import {CLASSIFICATION_AUTHORITY_CHANGED_EVENT} from './useClassificationAuthoritySync';
/** A remote trash, restore or accepted purge changed local Asset lifecycle (trash count, galleries). */
export const ASSET_LIFECYCLE_CHANGED_EVENT = 'lakomics-asset-lifecycle-changed';
export function useAssetAuthoritySync(gateway:LibraryGateway,libraryRoot:string) {
  useEffect(()=>{
    if (nativeWorkload()) {
      let stopped = false;
      let unlisten: (() => void) | undefined;
      const changed = () => {
        window.dispatchEvent(new Event(CLASSIFICATION_AUTHORITY_CHANGED_EVENT));
        window.dispatchEvent(new Event(ALBUM_AUTHORITY_CHANGED_EVENT));
        window.dispatchEvent(new Event(ASSET_LIFECYCLE_CHANGED_EVENT));
      };
      // No focus relay: the native pass already wakes on window focus and emits this
      // event only when local Asset state really changed.
      void listen("library://asset-authority-changed", changed).then(stop => { if (stopped) stop(); else unlisten = stop; }).catch(() => undefined);
      return () => { stopped = true; unlisten?.(); };
    }
    if (!gateway.syncAssetAuthority) return;
    let active=true,running=false;
    const run=async()=>{
      if (!active||running) return; running=true;
      try {
        const result=await gateway.syncAssetAuthority!();
        if (active && (result.appliedChanges>0 || result.materialized>0 || result.flushed>0)) {
          window.dispatchEvent(new Event(CLASSIFICATION_AUTHORITY_CHANGED_EVENT));
          window.dispatchEvent(new Event(ALBUM_AUTHORITY_CHANGED_EVENT));
          window.dispatchEvent(new Event(ASSET_LIFECYCLE_CHANGED_EVENT));
        }
      } catch { /* Durable intent and cursors survive; the next pass retries. */ }
      finally {running=false;}
    };
    void run();const timer=window.setInterval(()=>void run(),5000);
    window.addEventListener('focus',run);window.addEventListener('online',run);
    return()=>{active=false;clearInterval(timer);window.removeEventListener('focus',run);window.removeEventListener('online',run);};
  },[gateway,libraryRoot]);
}
