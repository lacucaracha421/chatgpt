import {useEffect,useLayoutEffect,useRef,useState} from 'react';
import {XMarkIcon} from '@heroicons/react/24/outline';
import {assetSearchKey,type AssetSearchName} from '../src/assets/assetSearch';
import {Button} from './ui';
import {prefersReducedMotion,EASE_OUT,SWAP_MOTION_MS} from './motion';
import './assetSearch.css';
function Chip({chip,leaving,onRemove}:{chip:AssetSearchName;leaving:boolean;onRemove(chip:AssetSearchName):void}) {
  const host=useRef<HTMLSpanElement>(null);
  useLayoutEffect(()=>{
    const element=host.current;
    if(!element?.animate||prefersReducedMotion())return;
    const width=element.firstElementChild?.getBoundingClientRect().width??0;
    const frames=[{width:'0px',opacity:0},{width:`${width}px`,opacity:1}];
    const animation=element.animate(leaving?[...frames].reverse():frames,{duration:SWAP_MOTION_MS,easing:EASE_OUT,fill:'both'});
    if(!leaving)animation.onfinish=()=>animation.cancel();
    return()=>animation.cancel();
  },[leaving]);
  return <span ref={host} className="asset-scope-chip-slot" aria-hidden={leaving||undefined}><Button type="button" variant="ghost" className="asset-scope-chip" disabled={leaving} aria-label={`${chip.name} 범위 제거`} onClick={()=>onRemove(chip)}>{chip.name}<XMarkIcon aria-hidden="true"/></Button></span>;
}
export function AssetScopeChips({chips,onRemove,onClear}:{chips:readonly AssetSearchName[];onRemove(chip:AssetSearchName):void;onClear?():void}) {
  const [shown,setShown]=useState(chips.map(chip=>({chip,leaving:false})));
  useLayoutEffect(()=>setShown(previous=>[
    ...previous.map(row=>({chip:chips.find(chip=>assetSearchKey(chip)===assetSearchKey(row.chip))??row.chip,leaving:!chips.some(chip=>assetSearchKey(chip)===assetSearchKey(row.chip))})),
    ...chips.filter(chip=>!previous.some(row=>assetSearchKey(chip)===assetSearchKey(row.chip))).map(chip=>({chip,leaving:false})),
  ]),[chips]);
  useEffect(()=>{
    if(!shown.some(row=>row.leaving))return;
    const timer=window.setTimeout(()=>setShown(previous=>previous.filter(row=>!row.leaving)),prefersReducedMotion()?0:SWAP_MOTION_MS);
    return()=>clearTimeout(timer);
  },[shown]);
  if(!shown.length)return null;
  return <div className="filter-chips asset-scope-chips" role="group" aria-label="에셋 검색 범위">{shown.map(({chip,leaving})=><Chip key={assetSearchKey(chip)} chip={chip} leaving={leaving} onRemove={onRemove}/>)}{chips.length>=2&&onClear&&<Button type="button" variant="quiet" onClick={onClear}>모두 지우기</Button>}</div>;
}
