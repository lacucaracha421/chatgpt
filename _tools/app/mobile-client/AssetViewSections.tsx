import {ViewOptionsSection} from '../src/shared/ui/ViewOptionsSection';
import {ASSET_SORTS,SORT_LABELS,sortOf,withSort,type AssetSort} from './assetFilters';
import {FilterOptionsSection} from './FilterChips';
import type {AssetFiltersValue} from './types';
import {Button,SegmentedControl} from './ui';

/** Asset view choices share the gallery's query owner, including character galleries. */
export function AssetViewSections({value,onChange,sorts=ASSET_SORTS,onSort,onShuffle}:{value:AssetFiltersValue;onChange(value:AssetFiltersValue):void;sorts?:readonly AssetSort[];onSort?(sort:AssetSort):void;onShuffle?():void}) {
  return <>
    <ViewOptionsSection title="정렬"><SegmentedControl<AssetSort> label="정렬" options={sorts.map(sort=>({value:sort,label:SORT_LABELS[sort]}))} value={sortOf(value)} fullWidth onChange={sort=>onSort?onSort(sort):onChange(withSort(value,sort))}/>{sortOf(value)==='random'&&onShuffle&&<Button variant="ghost" onClick={onShuffle}>다시 섞기</Button>}</ViewOptionsSection>
    <FilterOptionsSection group="aspect" value={value} onChange={onChange}/>
    <FilterOptionsSection group="duration" value={value} onChange={onChange}/>
  </>;
}
