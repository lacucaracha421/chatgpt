import {useHorizontalWheel} from '../src/shared/ui/useHorizontalWheel';
import {ChevronDownIcon} from '@heroicons/react/24/outline';
import {BottomSheet} from './BottomSheet';
import {ASPECT_LABELS,DURATION_LABELS,MEDIA_LABELS,EMPTY_FILTERS,hasActiveFilters,queryExtras} from './assetFilters';
import type {AssetFiltersValue} from './types';
import {ViewOptionsSection} from '../src/shared/ui/ViewOptionsSection';
import {SegmentedControl} from './ui';
export type FilterGroup=keyof AssetFiltersValue;
const groups={media:{label:'종류',labels:MEDIA_LABELS},aspect:{label:'비율',labels:ASPECT_LABELS},duration:{label:'길이',labels:DURATION_LABELS}};
/** One filter group as a full-width segmented row, as in the PC 보기 menu. Length only narrows videos, so it is left out while the kind is limited to images. */
export function FilterOptionsSection({group,value,onChange}:{group:FilterGroup;value:AssetFiltersValue;onChange(value:AssetFiltersValue):void}) {
  if(group==='duration'&&value.media==='images')return null;
  return <ViewOptionsSection title={groups[group].label}><FilterSegments group={group} value={value} onChange={onChange}/></ViewOptionsSection>;
}
function FilterSegments({group,value,onChange}:{group:FilterGroup;value:AssetFiltersValue;onChange(value:AssetFiltersValue):void}) {
  const options=Object.entries(groups[group].labels).map(([key,label])=>({value:key,label}));
  return <SegmentedControl label={groups[group].label} options={options} value={value[group]} fullWidth onChange={key=>onChange(group==='media'&&key==='images'?{...value,media:'images',duration:'all'}:{...value,[group]:key})}/>;
}
/**
 * The filter chip row and each group's choice sheet. `row` and `sheet` split the two, so the row
 * can live inside the 보기 옵션 sheet while the choice sheet opens on its own (never nested).
 */
export function FilterChips({value,applied=value,onChange,open,onOpen,media=true,aspect=true,duration=true,row=true,sheet=true,variant='default',showReset=true}:{value:AssetFiltersValue;applied?:AssetFiltersValue;onChange(value:AssetFiltersValue):void;open:FilterGroup|null;onOpen(group:FilterGroup|null):void;media?:boolean;aspect?:boolean;duration?:boolean;row?:boolean;sheet?:boolean;variant?:'default'|'toolbar';showReset?:boolean}) {
  const stripWheel=useHorizontalWheel();
  const enabled={media,aspect,duration};
  // Length only narrows videos, so it is unavailable while the kind is limited to images.
  const imagesOnly=value.media==='images';
  // A reset clears the filters, not the sort, the shuffle's seed or the folder's subtree mode.
  const clear=()=>onChange({...EMPTY_FILTERS,...queryExtras(value)} as AssetFiltersValue);
  const visibleGroups=(Object.keys(groups) as FilterGroup[]).filter(key=>enabled[key]&&!(key==='duration'&&imagesOnly));
  return <>{row&&<div ref={stripWheel} className={`filter-chips${variant==='toolbar'?' filter-chips--toolbar':''}`} role="group" aria-label="자산 필터">{visibleGroups.map(key=>{
    const group=groups[key],labels:Record<string,string>=group.labels;
    return <button key={key} className={`filter-chip${variant==='toolbar'?' filter-chip--toolbar':''}${applied[key]!=='all'?' selected':''}`} onClick={()=>onOpen(key)}>{applied[key]==='all'?group.label:labels[applied[key]]}<ChevronDownIcon/></button>;
  })}{showReset&&(hasActiveFilters(value)||hasActiveFilters(applied))&&<button className={`filter-chip${variant==='toolbar'?' filter-chip--toolbar':''}`} onClick={clear}>초기화</button>}</div>}
  {sheet&&open&&!(open==='duration'&&imagesOnly)&&<BottomSheet title={groups[open].label} onClose={()=>onOpen(null)}><FilterSegments group={open} value={value} onChange={onChange}/></BottomSheet>}</>;
}
