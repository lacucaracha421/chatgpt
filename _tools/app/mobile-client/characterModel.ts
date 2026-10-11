import {assetSearchParams,type AssetSearchName} from '../src/assets/assetSearch';
import type {AssetFiltersValue,Classification} from './types';
import {EMPTY_FILTERS, filterParams, sortOf} from './assetFilters';
import type {ScopedAssetPage} from './scopedAssetToc';
export type CharacterFilter = 'all' | 'unclassified' | 'needs_review';
/** Assets that define this character (its base and learned references). Only an upgraded
 * publisher sends the field, so `undefined` is "this server cannot tell", never "none". */
export type CharacterNode = {
  id:string; kind:'series'|'group'|'character'|'folder'; sourceId:string; seriesId:string;
  parentId:string|null; name:string; description:string; thumbnailAssetId:string|null;
  heroAssetId?:string|null;
  manualOnly:boolean; excluded:boolean;
  protectedAssetIds?:string[];
  /** `extras` is a 기타 bucket (a `character` node the screens call just "기타", always last among character cards).
   * Absent on older snapshots: an ordinary character. */
  role?:'character'|'extras';
};
export const isExtrasNode=(node:Pick<CharacterNode,'role'>|undefined|null)=>node?.role==='extras';
/** The stored name of a 기타 is "<group or series> 기타"; every screen shows just 기타. */
export const characterNodeName=(node:Pick<CharacterNode,'name'|'role'>)=>node.role==='extras'?'기타':node.name;
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
  contentRatings?: Record<string, import("../src/shared/privacy/contentMask").ContentRating | null>;
  version:1;authority:'pc';authorityEpoch:0;capabilities:{read:boolean;write:boolean;manualExclusion?:boolean;characterReview?:boolean};
  libraryId?:string;exclusionCursor?:number;reviewDecisionCursor?:number;appliedReviewDecisionCursor?:number;
  navigationOrder?:string[];ready:boolean;revision:string|null;publishedAt:string|null;nodes:CharacterNode[];scopes:CharacterScope[];
};
export type CharacterPage = ScopedAssetPage & {revision:string;totalCount:number;sourceCount:number};
/**
 * One character-scope page.
 *
 * Membership stays frozen at publication; the requested `revision` is what pins it. Asset
 * filters are applied by the server against the live Asset metadata for the members of
 * that frozen scope, so a filter never needs a new publication to become meaningful —
 * only the membership and the scope counts do. Tablet pages explicitly use the live
 * newest date order, whose TOC cursors differ from the server's default published order.
 */
export function characterPath(node:string,filter:CharacterFilter,revision:string,cursor:string|null,filters:AssetFiltersValue=EMPTY_FILTERS,search:readonly AssetSearchName[]=[],toc=false) {
  const params=assetSearchParams(new URLSearchParams({node,filter,revision,limit:'40',sort:sortOf(filters)}),search,false);
  if(toc){params.delete('limit');params.set('toc','1');params.set('utcOffsetMinutes',String(-new Date().getTimezoneOffset()));}
  if(cursor)params.set('cursor',cursor);
  for(const [key,value] of filterParams(filters))params.set(key,value);
  // The character route sorts by date only (published · newest · oldest); 좋아요순 and 랜덤 fall back to newest.
  params.set('sort',sortOf(filters)==='oldest'?'oldest':'newest');params.delete('seed');
  return `/v1/library/characters/assets?${params}`;
}
export function characterChildren(index:CharacterIndex,node:string|null,classifications:readonly Classification[]=[]) {
  // 그룹 → 그룹 밖 캐릭터 → 기타 → 안쪽 시리즈 → 폴더, as on the PC; the server's order holds within each kind.
  const rank=(n:CharacterNode)=>n.kind==='group'?0:n.kind==='character'?(isExtrasNode(n)?2:1):n.kind==='series'?3:4;
  return index.nodes.filter(n=>characterParent(index,n,classifications)===node).sort((a,b)=>rank(a)-rank(b));
}
/**
 * The 기타 that stands for a group with no member character (it is the group's only child), or
 * `null`. Such a group opens straight to its 기타 images under the group's own name.
 */
export function soloExtrasNode(index:CharacterIndex,node:CharacterNode|undefined|null) {
  if(node?.kind!=='group')return null;
  const children=index.nodes.filter(n=>n.parentId===node.id);
  return children.length===1&&isExtrasNode(children[0])?children[0]!:null;
}
/** The node whose scope a place reads: a group's only 기타 for that group, else the node itself. */
export function characterScopeNode(index:CharacterIndex|undefined,node:string):string {
  return index?soloExtrasNode(index,index.nodes.find(n=>n.id===node))?.id??node:node;
}
export function characterParent(index:CharacterIndex,node:CharacterNode,classifications:readonly Classification[]=[]) {
  if(node.kind!=='series')return node.parentId;
  const parent=classifications.find(c=>c.id===node.sourceId)?.parent_id;
  return index.nodes.find(n=>(n.kind==='series'||n.kind==='folder')&&n.sourceId===parent)?.id??node.parentId;
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
/**
 * The library id mobile character-review decisions are sent under, or `null` while no PC has
 * adopted review (the entry points stay hidden then).
 */
export function characterReviewLibrary(value:CharacterIndex|undefined|null):string|null {
  const libraryId=value?.libraryId;
  if(value?.capabilities?.characterReview!==true)return null;
  return typeof libraryId==='string'&&/^[a-f0-9]{32}$/.test(libraryId)?libraryId:null;
}
