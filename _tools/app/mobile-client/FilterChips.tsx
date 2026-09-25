import {ChevronDownIcon} from '@heroicons/react/24/outline';
import {BottomSheet} from './BottomSheet';
import {ASPECT_LABELS,DURATION_LABELS,MEDIA_LABELS,EMPTY_FILTERS,hasActiveFilters} from './assetFilters';
import type {AssetFiltersValue} from './types';
export type FilterGroup=keyof AssetFiltersValue;
const groups={media:{label:'종류',labels:MEDIA_LABELS},aspect:{label:'비율',labels:ASPECT_LABELS},duration:{label:'길이',labels:DURATION_LABELS}};
/** Groups narrowed away from 전체, the count the 보기 옵션 button shows. */
export function activeFilterCount(value:AssetFiltersValue) {return (Object.keys(groups) as FilterGroup[]).filter(key=>value[key]!=='all').length;}
/**
 * The filter chip row and each group's choice sheet. `row` and `sheet` split the two, so the row
 * can live inside the 보기 옵션 sheet while the choice sheet opens on its own (never nested).
 */
export function FilterChips({value,applied=value,onChange,open,onOpen,media=true,aspect=true,duration=true,row=true,sheet=true}:{value:AssetFiltersValue;applied?:AssetFiltersValue;onChange(value:AssetFiltersValue):void;open:FilterGroup|null;onOpen(group:FilterGroup|null):void;media?:boolean;aspect?:boolean;duration?:boolean;row?:boolean;sheet?:boolean}) {
  const enabled={media,aspect,duration};
  // Length only narrows videos, so it is unavailable while the kind is limited to images.
  const imagesOnly=value.media==='images';
  const choose=(group:FilterGroup,key:string)=>onChange(group==='media'&&key==='images'?{...value,media:'images',duration:'all'}:{...value,[group]:key});
  return <>{row&&<div className="filter-chips" role="group" aria-label="자산 필터">{(Object.keys(groups) as FilterGroup[]).filter(key=>enabled[key]).map(key=>{
    const group=groups[key],labels:Record<string,string>=group.labels;
    const off=key==='duration'&&imagesOnly;
    return <button key={key} className={`filter-chip ${applied[key]!=='all'&&!off?'selected':''}`} disabled={off} aria-label={off?'길이 (이미지에는 적용되지 않음)':undefined} onClick={()=>onOpen(key)}>{applied[key]==='all'?group.label:labels[applied[key]]}<ChevronDownIcon/></button>;
  })}{(hasActiveFilters(value)||hasActiveFilters(applied))&&<button className="filter-chip" onClick={()=>onChange({...EMPTY_FILTERS})}>초기화</button>}</div>}
  {sheet&&open&&<BottomSheet title={groups[open].label} onClose={()=>onOpen(null)}><div role="radiogroup" aria-label={groups[open].label}>{Object.entries(groups[open].labels).map(([key,label])=><button className="sheet-option" role="radio" aria-checked={value[open]===key} key={key} onClick={()=>choose(open,key)}>{label}<span className="radio-dot"/></button>)}</div>{open==='duration'&&<p className="hint">길이는 영상에만 적용됩니다.</p>}</BottomSheet>}</>;
}
