import type {AssetFiltersValue, Page} from './types';
import {EMPTY_FILTERS, withFilters} from './assetFilters';
export type CharacterFilter = 'all' | 'unclassified' | 'needs_review';
export type CharacterNode = {
  id:string; kind:'series'|'group'|'character'|'folder'; sourceId:string; seriesId:string;
  parentId:string|null; name:string; description:string; thumbnailAssetId:string|null;
  heroAssetId?:string|null;
  manualOnly:boolean; excluded:boolean;
};
export type CharacterScope = {nodeId:string;filter:CharacterFilter;totalCount:number;sourceCount:number};
export type CharacterIndex = {
  version:1;authority:'pc';authorityEpoch:0;capabilities:{read:boolean;write:boolean};
  navigationOrder?:string[];ready:boolean;revision:string|null;publishedAt:string|null;nodes:CharacterNode[];scopes:CharacterScope[];
};
export type CharacterPage = Page & {revision:string;totalCount:number;sourceCount:number};
/**
 * One character-scope page.
 *
 * Membership stays frozen at publication; the requested `revision` is what pins it. Asset
 * filters are applied by the server against the live Asset metadata for the members of
 * that frozen scope, so a filter never needs a new publication to become meaningful —
 * only the membership and the scope counts do.
 */
export function characterPath(node:string,filter:CharacterFilter,revision:string,cursor:string|null,filters:AssetFiltersValue=EMPTY_FILTERS) {
  const params=new URLSearchParams({node,filter,revision,limit:'40'});
  if(cursor)params.set('cursor',cursor);
  return withFilters(`/v1/library/characters/assets?${params}`,filters);
}
export function characterChildren(index:CharacterIndex,node:string|null) {
  const rank={series:0,group:0,character:1,folder:2};
  return index.nodes.filter(n=>n.parentId===node).sort((a,b)=>rank[a.kind]-rank[b.kind]);
}
export function validCharacterIndex(value:CharacterIndex) {
  return value.version===1 && value.authority==='pc' && value.authorityEpoch===0 && value.capabilities?.read===true &&
    Array.isArray(value.nodes) && Array.isArray(value.scopes) && (!value.ready || /^[a-f0-9]{64}$/.test(value.revision??''));
}
