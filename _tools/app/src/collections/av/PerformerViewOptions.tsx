import { PerRowControl } from '../../shared/ui/PerRowControl';
import { SegmentedControl } from '../../shared/ui/SegmentedControl';
import { ViewOptionsSection } from '../../shared/ui/ViewOptionsSection';
import { defaultPerformerDirection, PERFORMER_SORTS, performerDirections } from './performerGridModel';
import type { PerformerView } from './usePerformerView';
import './performerGrid.css';

export function PerformerViewOptions({value,onChange,tablet=false}:{value:PerformerView;onChange(patch:Partial<PerformerView>):void;tablet?:boolean}) {
  return <><ViewOptionsSection title="배치"><PerRowControl value={value.columns} min={tablet?2:3} max={tablet?5:10} onChange={columns=>onChange({columns})}/></ViewOptionsSection>
    <ViewOptionsSection title="정렬"><div className="collection-view-sort__row"><span className="collection-view-sort__label">기준</span>
      <div className="performer-sort" role="radiogroup" aria-label="정렬 기준">{PERFORMER_SORTS.map((option,index)=><button key={option.value} type="button" className="performer-sort__row" role="radio" aria-checked={value.sort===option.value} tabIndex={value.sort===option.value?0:-1}
        onClick={()=>{if(option.value!==value.sort)onChange({sort:option.value,direction:defaultPerformerDirection(option.value)});}}
        onKeyDown={event=>{if(!['ArrowUp','ArrowDown','Home','End'].includes(event.key))return;event.preventDefault();const next=event.key==='Home'?0:event.key==='End'?PERFORMER_SORTS.length-1:(index+(event.key==='ArrowUp'?-1:1)+PERFORMER_SORTS.length)%PERFORMER_SORTS.length;const sort=PERFORMER_SORTS[next].value;onChange({sort,direction:defaultPerformerDirection(sort)});(event.currentTarget.parentElement?.children[next] as HTMLElement)?.focus();}}><span>{option.label}</span></button>)}</div></div>
      <div className="collection-view-sort__row"><span className="collection-view-sort__label">순서</span><SegmentedControl label="정렬 순서" options={performerDirections(value.sort)} value={value.direction} fullWidth onChange={direction=>onChange({direction})}/></div>
    </ViewOptionsSection></>;
}
