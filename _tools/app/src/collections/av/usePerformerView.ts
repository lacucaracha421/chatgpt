import { useState } from 'react';
import { PERFORMER_SORTS, type PerformerSort, type PerformerDirection } from './performerGridModel';

export type PerformerView = {view:'works'|'performers';sort:PerformerSort;direction:PerformerDirection;columns:number};
const keyFor = (library:string,tablet:boolean) => `lakomics.av-performer-view.${tablet?'tablet':'pc'}.${library}`;
export function readPerformerView(library:string,tablet=false): PerformerView {
  const defaults:PerformerView = {view:'works',sort:'count',direction:'desc',columns:tablet?3:6};
  try {
    const saved = JSON.parse(localStorage.getItem(keyFor(library,tablet)) ?? 'null');
    if (!saved) return defaults;
    return {view:saved.view==='performers'?'performers':'works',sort:PERFORMER_SORTS.some(option=>option.value===saved.sort)?saved.sort:defaults.sort,
      direction:saved.direction==='asc'?'asc':'desc',columns:Number.isInteger(saved.columns)?Math.max(tablet?2:3,Math.min(tablet?5:10,saved.columns)):defaults.columns};
  } catch { return defaults; }
}
export function usePerformerView(library:string,tablet=false):[PerformerView,(patch:Partial<PerformerView>)=>void] {
  const key = keyFor(library,tablet);
  const [state,setState] = useState(()=>({key,value:readPerformerView(library,tablet)}));
  const value = state.key===key?state.value:readPerformerView(library,tablet);
  if(state.key!==key)setState({key,value});
  return [value,patch=>setState(current=>{
    const value = {...(current.key===key?current.value:readPerformerView(library,tablet)),...patch};
    try {localStorage.setItem(key,JSON.stringify(value));} catch { /* Retain the session choice when storage is unavailable. */ }
    return {key,value};
  })];
}
