import type {Page} from './types';
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
export function characterPath(node:string,filter:CharacterFilter,revision:string,cursor:string|null) {
  const params=new URLSearchParams({node,filter,revision,limit:'40'});
  if(cursor)params.set('cursor',cursor);
  return `/v1/library/characters/assets?${params}`;
}
export function characterChildren(index:CharacterIndex,node:string|null) {
  const rank={series:0,group:0,character:1,folder:2};
  return index.nodes.filter(n=>n.parentId===node).sort((a,b)=>rank[a.kind]-rank[b.kind]);
}
export function validCharacterIndex(value:CharacterIndex) {
  return value.version===1 && value.authority==='pc' && value.authorityEpoch===0 && value.capabilities?.read===true &&
    Array.isArray(value.nodes) && Array.isArray(value.scopes) && (!value.ready || /^[a-f0-9]{64}$/.test(value.revision??''));
}
