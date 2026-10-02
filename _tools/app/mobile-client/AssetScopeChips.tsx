import {XMarkIcon} from '@heroicons/react/24/outline';
import {assetSearchKey,type AssetSearchName} from '../src/assets/assetSearch';
import {Button} from './ui';
import './assetSearch.css';
/** An array keeps the scope row ready for the later multi-chip filter contract. */
export function AssetScopeChips({chips,onRemove}:{chips:AssetSearchName[];onRemove(chip:AssetSearchName):void}) {
  if(!chips.length)return null;
  return <div className="filter-chips asset-scope-chips" role="group" aria-label="에셋 검색 범위">{chips.map(chip=><Button key={assetSearchKey(chip)} type="button" variant="ghost" className="asset-scope-chip" aria-label={`${chip.name} 범위 제거`} onClick={()=>onRemove(chip)}>{chip.name}<XMarkIcon aria-hidden="true"/></Button>)}</div>;
}
