/**
 * The one Asset filter surface, shared by every scope that supports filtering.
 *
 * It is a dialog body rather than a toolbar so the gallery keeps its height: the
 * mobile consumption contract reduces persistent chrome and keeps assets dominant,
 * and a permanent filter bar would take the space the tiles need. Each row is a
 * labelled group of `aria-pressed` buttons, matching the shipped density control in
 * the gallery view-settings dialog and the Collection rating-range group.
 *
 * A control is drawn only when its group can actually be satisfied by this scope, so
 * an Album or Character gallery never implies an ability the request does not have.
 */
import {Button} from './ui';
import {ASPECT_LABELS, DURATION_LABELS, EMPTY_FILTERS, MEDIA_LABELS, hasActiveFilters, sameFilters} from './assetFilters';
import type {AssetAspectFilter, AssetDurationFilter, AssetFiltersValue, AssetMediaFilter} from './types';

function Group<T extends string>({label, value, labels, onChange}: {label:string; value:T; labels:Record<T,string>; onChange(value:T):void}) {
  const keys = Object.keys(labels) as T[];
  return <div className="asset-filter-group">
    <span className="asset-filter-label">{label}</span>
    <div className="asset-filter-options" role="group" aria-label={label}>
      {keys.map(key => <Button key={key} variant="ghost" aria-pressed={value === key} onClick={() => onChange(key)}>{labels[key]}</Button>)}
    </div>
  </div>;
}
export function AssetFilters({value, onChange, media = true, aspect = true, duration = true}: {
  value:AssetFiltersValue;
  onChange(value:AssetFiltersValue):void;
  media?:boolean; aspect?:boolean; duration?:boolean;
}) {
  return <div className="asset-filters">
    {media && <Group label="미디어" value={value.media} labels={MEDIA_LABELS} onChange={(next:AssetMediaFilter) => onChange({...value, media:next})}/>}
    {aspect && <Group label="비율" value={value.aspect} labels={ASPECT_LABELS} onChange={(next:AssetAspectFilter) => onChange({...value, aspect:next})}/>}
    {duration && <>
      <Group label="길이" value={value.duration} labels={DURATION_LABELS} onChange={(next:AssetDurationFilter) => onChange({...value, duration:next})}/>
      {/* PC has no duration filter, so this states its scope rather than letting the
          user assume it narrows an image result set. */}
      <p className="hint asset-filter-note">길이는 영상에만 적용됩니다. 이미지와 GIF는 길이 조건에서 제외됩니다.</p>
    </>}
    {hasActiveFilters(value) && <div className="asset-filter-reset"><Button variant="ghost" onClick={() => onChange({...EMPTY_FILTERS})}>필터 해제</Button></div>}
  </div>;
}
/** The compact applied-filter summary shown in the heading, so the state is never hidden. */
export function filterSummary(value: AssetFiltersValue) {
  if (sameFilters(value, EMPTY_FILTERS)) return '';
  const parts:string[] = [];
  if (value.media !== 'all') parts.push(MEDIA_LABELS[value.media]);
  if (value.aspect !== 'all') parts.push(ASPECT_LABELS[value.aspect]);
  if (value.duration !== 'all') parts.push(DURATION_LABELS[value.duration]);
  return parts.join(' · ');
}
