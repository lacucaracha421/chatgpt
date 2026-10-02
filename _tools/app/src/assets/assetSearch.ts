import {matchesKoreanSearch} from '../shared/koreanSearch';

export const ASSET_SEARCH_GROUPS = [
  {kind:'folder',label:'폴더'}, {kind:'character',label:'캐릭터'},
  {kind:'album',label:'앨범'}, {kind:'artist',label:'작가'},
] as const;
export type AssetSearchKind = typeof ASSET_SEARCH_GROUPS[number]['kind'];
export type AssetSearchIdentity = {kind:AssetSearchKind;id:string};
export type AssetSearchName = AssetSearchIdentity & {name:string;count?:number};
export function assetSearchKey(item:AssetSearchIdentity) { return `${item.kind}:${item.id}`; }
export function groupAssetSuggestions<T extends AssetSearchName>(items:readonly T[],query:string) {
  return ASSET_SEARCH_GROUPS.map(group=>({...group,items:items.filter(item=>item.kind===group.kind&&matchesKoreanSearch(item.name,query))}));
}
/** Store identities only; names, counts and destinations always come from the current lists. */
export function rememberAssetSearch(previous:AssetSearchIdentity[],item:AssetSearchIdentity) {
  return [{kind:item.kind,id:item.id},...previous.filter(old=>assetSearchKey(old)!==assetSearchKey(item))].slice(0,8);
}
