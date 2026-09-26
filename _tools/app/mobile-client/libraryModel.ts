import type {Classification,View} from './types';
import type {CharacterIndex,CharacterNode} from './characterModel';
import {createKoreanMatcher} from '../src/shared/koreanSearch';
export type Entry=Classification&{characterNode?:string;characterKind?:Exclude<CharacterNode['kind'],'series'>};
export const LIBRARY_ROOT:View={tab:'library',root:true,title:'에셋'};
export const ALL_ASSETS:View={tab:'library',title:'모든 자산'};
export function mergeLibraryEntries(items:Classification[],characters?:CharacterIndex):Entry[]{
    const nodes=characters?.ready?characters.nodes:[];
    const series=new Map(nodes.filter(n=>n.kind==='series').map(n=>[n.sourceId,n]));
    const merged:Entry[]=items.map(item=>({...item,characterNode:series.get(item.id)?.id,asset_count:series.has(item.id)?characters?.scopes.find(scope=>scope.nodeId===series.get(item.id)?.id&&scope.filter==='all')?.totalCount??item.asset_count:item.asset_count}));
    for(const node of nodes){
      if(node.kind==='series'&&!merged.some(item=>item.id===node.sourceId))merged.push({id:node.sourceId,name:node.name,parent_id:null,asset_count:characters?.scopes.find(scope=>scope.nodeId===node.id&&scope.filter==='all')?.totalCount??0,characterNode:node.id});
      if(node.kind==='group'||node.kind==='character'){
        const id=node.kind==='group'?`character-group:${node.sourceId}`:node.id;
        const parent=node.parentId?.startsWith('group:')?`character-group:${node.parentId.slice(6)}`:node.seriesId;
        merged.push({id,name:node.name,parent_id:parent,asset_count:characters?.scopes.find(s=>s.nodeId===node.id&&s.filter==='all')?.totalCount??0,characterNode:node.id,characterKind:node.kind});
      }
    }
    const order=new Map((characters?.navigationOrder??[]).map((id,i)=>[id,i]));
    merged.sort((a,b)=>(order.get(a.id)??Number.MAX_SAFE_INTEGER)-(order.get(b.id)??Number.MAX_SAFE_INTEGER)||a.name.localeCompare(b.name,'ko'));
    const linked=linkedCharacterFolders(merged,nodes);
    const kept=merged.filter(item=>!linked.has(item.id)).map(item=>linked.has(item.parent_id??'')?{...item,parent_id:linked.get(item.parent_id!)!}:item);
    const ids=new Set(kept.map(item=>item.id));
    return kept.map(item=>({...item,parent_id:ids.has(item.parent_id??'')?item.parent_id:null}));
}
export function ancestorsOf(entries:Entry[],id?:string):Entry[]{
 const result:Entry[]=[],seen=new Set<string>(id?[id]:[]);let current=entries.find(e=>e.id===id);
 while(current?.parent_id&&!seen.has(current.parent_id)){seen.add(current.parent_id);current=entries.find(e=>e.id===current!.parent_id);if(current)result.unshift(current);}
 return result;
}
export function searchLibraryEntries(entries:Entry[],query:string){const matches=createKoreanMatcher(query);return entries.filter(entry=>matches(entry.name));}
export function entryView(entry:Entry):View{return entry.characterNode?{tab:'library',characters:true,characterNode:entry.characterNode,title:entry.name}:{tab:'library',classification:entry.id,title:entry.name};}
export function isAll(view:View){return view.tab==='library'&&!view.root&&!view.characters&&!view.classification&&!view.revisit;}

/**
 * Ordinary folders that stand for a published character, mapped to that character's entry.
 *
 * The PC links a character to its own folder and hides that folder from character browsing,
 * but the publication does not carry the link, so the plain classification list would show
 * the same character twice with different counts (folder members vs. character gallery).
 * Inside the character's series, a folder with the character's exact name is treated as its
 * linked folder; its sub-folders move under the character entry.
 */
function linkedCharacterFolders(entries:Entry[],nodes:CharacterNode[]):Map<string,string>{
  const byId=new Map(entries.map(entry=>[entry.id,entry])),key=(name:string)=>name.trim().toLocaleLowerCase();
  const withinSeries=(entry:Entry,series:string)=>{const seen=new Set<string>();let parent=entry.parent_id;while(parent&&!seen.has(parent)){if(parent===series)return true;seen.add(parent);parent=byId.get(parent)?.parent_id??null;}return false;};
  const result=new Map<string,string>();
  for(const node of nodes){
    if(node.kind!=='character')continue;
    const folder=entries.find(entry=>!entry.characterNode&&key(entry.name)===key(node.name)&&withinSeries(entry,node.seriesId));
    if(folder&&!result.has(folder.id))result.set(folder.id,node.id);
  }
  return result;
}
