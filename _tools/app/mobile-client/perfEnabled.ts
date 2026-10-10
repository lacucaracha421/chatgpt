import type {} from './transport';

let enabled:boolean|undefined;
/** The native log property needs a process restart; every observer shares this page's flag. */
export function perfEnabled():boolean {
  if(enabled===undefined){
    try{enabled=window.LakomicsNative?.perfEnabled?.()===true;}catch{enabled=false;}
  }
  return enabled;
}
export function resetPerfEnabledForTests(){enabled=undefined;}
