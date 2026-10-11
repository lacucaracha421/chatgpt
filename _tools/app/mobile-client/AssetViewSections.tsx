import {ViewOptionsSection} from '../src/shared/ui/ViewOptionsSection';
import {ASSET_SORTS,SORT_LABELS,sortOf,withSort,type AssetSort} from './assetFilters';
import {FilterOptionsSection} from './FilterChips';
import type {AssetFiltersValue} from './types';
import {Button} from './ui';

/** Asset view choices share the gallery's query owner, including character galleries. */
export function AssetViewSections({value,onChange,sorts=ASSET_SORTS,onSort,onShuffle}:{value:AssetFiltersValue;onChange(value:AssetFiltersValue):void;sorts?:readonly AssetSort[];onSort?(sort:AssetSort):void;onShuffle?():void}) {
  return <>
    <ViewOptionsSection title="정렬"><div role="radiogroup" aria-label="정렬">{sorts.map(sort=><button key={sort} className="sheet-option" role="radio" aria-checked={sortOf(value)===sort} onClick={()=>onSort?onSort(sort):onChange(withSort(value,sort))}>{SORT_LABELS[sort]}<span className="radio-dot"/></button>)}</div>{sortOf(value)==='random'&&onShuffle&&<Button variant="ghost" onClick={onShuffle}>다시 섞기</Button>}</ViewOptionsSection>
    <FilterOptionsSection group="aspect" value={value} onChange={onChange}/>
    <FilterOptionsSection group="duration" value={value} onChange={onChange}/>
  </>;
}
