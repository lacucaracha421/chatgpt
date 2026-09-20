import type {AssetFiltersValue, Page} from './types';
import {EMPTY_FILTERS, withFilters} from './assetFilters';
export type CharacterFilter = 'all' | 'unclassified' | 'needs_review';
/** Assets that define this character (its base and learned references). Only an upgraded
 * publisher sends the field, so `undefined` is "this server cannot tell", never "none". */
export type CharacterNode = {
  id:string; kind:'series'|'group'|'character'|'folder'; sourceId:string; seriesId:string;
  parentId:string|null; name:string; description:string; thumbnailAssetId:string|null;
  heroAssetId?:string|null;
  manualOnly:boolean; excluded:boolean;
  protectedAssetIds?:string[];
};
export type CharacterScope = {nodeId:string;filter:CharacterFilter;totalCount:number;sourceCount:number};
/**
 * The manual-exclusion capability, kept as one value or nothing.
 *
 * `revision` is the index's own publication revision — the same field the asset scopes are
 * read at — and the cursor is the server's separate numeric change log. All three travel
 * together or not at all: a half-read identity could compose a write against the wrong
 * library or a revision no scope was ever published at.
 */
export type CharacterExclusion = {libraryId:string;revision:string;exclusionCursor:number};
export type CharacterIndex = {
  version:1;authority:'pc';authorityEpoch:0;capabilities:{read:boolean;write:boolean;manualExclusion?:boolean};
  libraryId?:string;exclusionCursor?:number;
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
/**
 * The character node a manual exclusion may name, or `null` when this view has none.
 *
 * `view.characterNode` is deliberately not consulted: series, group and ordinary folder
 * galleries open through the same field, and none of them is a character target.
 */
export function characterExclusionTarget(node:CharacterNode|undefined|null) {
  return node?.kind==='character'?node:null;
}
export function validCharacterIndex(value:CharacterIndex) {
  return value.version===1 && value.authority==='pc' && value.authorityEpoch===0 && value.capabilities?.read===true &&
    Array.isArray(value.nodes) && Array.isArray(value.scopes) && (!value.ready || /^[a-f0-9]{64}$/.test(value.revision??''));
}
/**
 * The manual-exclusion identity this index advertises, or `null` when it cannot be used.
 * The revision is the index's own publication revision; the cursor is the separate change log.
 */
export function characterExclusion(value:CharacterIndex|undefined|null):CharacterExclusion|null {
  const libraryId=value?.libraryId,cursor=value?.exclusionCursor;
  if(value?.capabilities?.manualExclusion!==true)return null;
  if(typeof libraryId!=='string'||!/^[a-f0-9]{32}$/.test(libraryId))return null;
  if(typeof value.revision!=='string'||!/^[a-f0-9]{64}$/.test(value.revision))return null;
  if(!Number.isSafeInteger(cursor)||(cursor??-1)<0)return null;
  return {libraryId,revision:value.revision,exclusionCursor:cursor!};
}
