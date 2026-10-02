import {matchesKoreanSearch} from '../shared/koreanSearch';

export const ASSET_SEARCH_GROUPS = [
  {kind:'folder',label:'폴더'}, {kind:'character',label:'캐릭터'},
  {kind:'album',label:'앨범'}, {kind:'artist',label:'작가'}, {kind:'tag',label:'태그'},
] as const;
export type AssetSearchKind = typeof ASSET_SEARCH_GROUPS[number]['kind'];
export type AssetSearchIdentity = {kind:AssetSearchKind;id:string;name?:string};
export type AssetSearchName = AssetSearchIdentity & {name:string;count?:number};
export function assetSearchKey(item:AssetSearchIdentity) { return `${item.kind}:${item.id}`; }
export function groupAssetSuggestions<T extends AssetSearchName>(items:readonly T[],query:string) {
  return ASSET_SEARCH_GROUPS.map(group=>({...group,items:items.filter(item=>item.kind===group.kind&&matchesKoreanSearch(item.name,query))}));
}
/** Local names resolve from current lists; recent tags retain their label for offline suggestions. */
export function rememberAssetSearch(previous:AssetSearchIdentity[],item:AssetSearchIdentity) {
  return [{kind:item.kind,id:item.id,...(item.kind==='tag'&&item.name?{name:item.name}:{})},...previous.filter(old=>assetSearchKey(old)!==assetSearchKey(item))].slice(0,8);
}

export const ASSET_SEARCH_LIMIT = 8;
export function assetSearchLimitHint(chips:readonly AssetSearchName[],kind:AssetSearchKind) {
  if((kind==='tag'||kind==='folder')&&chips.filter(chip=>chip.kind===kind).length>=ASSET_SEARCH_LIMIT)
    return kind==='tag'?'태그는 최대 8개입니다.':'폴더는 최대 8개입니다.';
  return '';
}
export function assetSearchChoiceHint(chips:readonly AssetSearchName[],item:AssetSearchName) {
  if(chips.some(chip=>assetSearchKey(chip)===assetSearchKey(item)))return '이미 선택했습니다.';
  return assetSearchLimitHint(chips,item.kind);
}
/** A scope switch retains tag/artist filters; folders and album/character scopes are exclusive. */
export function combineAssetSearchChoices<T extends AssetSearchName>(chips:readonly T[],item:T):T[] {
  if(assetSearchChoiceHint(chips,item))return [...chips];
  const retained=chips.filter(chip=>item.kind==='artist'?chip.kind!=='artist':item.kind==='folder'?chip.kind!=='album'&&chip.kind!=='character':item.kind==='album'||item.kind==='character'?chip.kind==='tag'||chip.kind==='artist':true);
  return [...retained,item];
}
export function assetSearchParams(params:URLSearchParams,chips:readonly AssetSearchName[]=[],classifications=true) {
  for(const chip of chips) {
    if(chip.kind==='tag')params.append('tag',chip.id);
    else if(chip.kind==='artist')params.set('artist',chip.id);
    else if(chip.kind==='folder'&&classifications&&!params.getAll('classification_id').includes(chip.id))params.append('classification_id',chip.id);
  }
  return params;
}
export function assetSearchSelectionKey(chips:readonly AssetSearchName[]=[]) {
  return chips.length?JSON.stringify(chips.map(assetSearchKey).sort()):'';
}
