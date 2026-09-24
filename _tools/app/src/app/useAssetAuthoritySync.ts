import {useEffect} from 'react';
import type {LibraryGateway} from '../library/types';
import {ALBUM_AUTHORITY_CHANGED_EVENT} from './useAlbumAuthoritySync';
import {CLASSIFICATION_AUTHORITY_CHANGED_EVENT} from './useClassificationAuthoritySync';
/** A remote trash, restore or accepted purge changed local Asset lifecycle (trash count, galleries). */
export const ASSET_LIFECYCLE_CHANGED_EVENT = 'lakomics-asset-lifecycle-changed';
export function useAssetAuthoritySync(gateway:LibraryGateway,libraryRoot:string) {
  useEffect(()=>{
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
